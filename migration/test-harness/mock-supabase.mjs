// A stand-in for Supabase, backed by the same Postgres container the SQL
// migrations were applied to.
//
// WHY THIS EXISTS: criteria 5, 11 and 12 are about the hosted UI actually
// working — CRUD from a browser, disabled features shown honestly, a dogfood
// pass with no console errors. Those cannot be checked by reading code, and
// the real Supabase project's API keys are not available to this session. So
// the client is pointed at this instead: it speaks enough PostgREST, GoTrue
// and Storage for the app to run unmodified against real Postgres holding the
// real migrated rows.
//
// WHAT THIS IS NOT: it is not a Supabase emulator and proves nothing about
// Supabase itself. RLS is NOT enforced here (it connects as a superuser), so
// it cannot and does not substitute for the RLS assertions in
// 10-rls-assertions.sql, which run against the real policies. What it does
// prove is that the client's request shapes, data flow, and UI states are
// correct.
//
// usage: node migration/test-harness/mock-supabase.mjs [port]

import http from "node:http";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 54321);
const CONTAINER = "gapvera-sqltest";
const DB = "gapvera";

// The owner seeded by 10-rls-assertions.sql.
const OWNER = { id: "22222222-2222-2222-2222-222222222222", email: "erik@example.com" };
const PASSWORD = "dogfood-test-password";

const sessions = new Map();
const objects = new Map(); // storage: path -> {buffer, type}

function psql(sql) {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", DB, "-tAc", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return out;
}

// Run a query and get JSON back, letting Postgres do the serialization so
// types survive the round trip the way PostgREST would deliver them.
function queryJson(sql) {
  const wrapped = `select coalesce(json_agg(t), '[]'::json)::text from (${sql}) t`;
  return JSON.parse(psql(wrapped).trim() || "[]");
}

// Same idea, but for INSERT/UPDATE/DELETE ... RETURNING. Postgres rejects a
// data-modifying statement inside a FROM subquery ("syntax error at or near
// into"), so the statement has to go in a CTE instead. Writes must use this.
function queryJsonWrite(sql) {
  const wrapped =
    `with t as (${sql}) select coalesce(json_agg(t), '[]'::json)::text from t`;
  return JSON.parse(psql(wrapped).trim() || "[]");
}

const lit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
};

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

// --- PostgREST filter translation -----------------------------------------
// Only the operators this client actually uses. Anything unrecognized throws
// rather than being silently ignored, so a missed case shows up as a failed
// request instead of a wrong result set.
function whereFrom(params) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const m = String(raw).match(/^([a-z]+)\.(.*)$/s);
    if (!m) continue;
    const [, op, value] = m;
    const col = ident(key);
    switch (op) {
      case "eq":
        clauses.push(value === "" ? `${col} = ''` : `${col} = ${lit(value)}`);
        break;
      case "neq":
        clauses.push(value === "" ? `${col} <> ''` : `${col} <> ${lit(value)}`);
        break;
      case "lte": clauses.push(`${col} <= ${lit(value)}`); break;
      case "gte": clauses.push(`${col} >= ${lit(value)}`); break;
      case "lt":  clauses.push(`${col} < ${lit(value)}`); break;
      case "gt":  clauses.push(`${col} > ${lit(value)}`); break;
      case "is":  clauses.push(`${col} is ${value === "null" ? "null" : lit(value)}`); break;
      case "like": clauses.push(`${col} like ${lit(value.replace(/\*/g, "%"))}`); break;
      case "in": {
        const items = value.replace(/^\(|\)$/g, "").split(",").map((s) => lit(s.trim()));
        clauses.push(`${col} in (${items.join(",")})`);
        break;
      }
      default:
        throw new Error(`unsupported PostgREST operator: ${op}`);
    }
  }
  return clauses.length ? ` where ${clauses.join(" and ")}` : "";
}

function orderFrom(params) {
  const order = params.get("order");
  if (!order) return "";
  const parts = order.split(",").map((p) => {
    const [col, dir] = p.split(".");
    return `${ident(col)} ${dir === "desc" ? "desc" : "asc"}`;
  });
  return ` order by ${parts.join(", ")}`;
}

// Embedded resources: `select=*,clients(business_name)` becomes a correlated
// json subquery, which is how the app gets its joined business_name.
function selectFrom(params, table) {
  const sel = params.get("select") || "*";
  const embed = sel.match(/([a-z_]+)\(([^)]*)\)/);
  let base = sel.replace(/,?[a-z_]+\([^)]*\)/g, "").trim() || "*";
  if (base !== "*") base = base.split(",").filter(Boolean).map((c) => ident(c.trim())).join(", ");

  if (!embed) return { cols: base, embedSql: "" };

  const [, relation, fields] = embed;
  const fk = relation === "clients" ? "client_id" : relation === "leads" ? "lead_id" : null;
  if (!fk) throw new Error(`unsupported embed: ${relation}`);
  const inner = fields.split(",").map((f) => ident(f.trim())).join(", ");
  const embedSql =
    `, (select row_to_json(x) from (select ${inner} from public.${relation} ` +
    `where ${relation}.id = ${table}.${fk}) x) as ${ident(relation)}`;
  return { cols: base === "*" ? `${table}.*` : base, embedSql };
}

const send = (res, status, body, extraHeaders = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "*",
    ...extraHeaders,
  });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname, searchParams } = url;

  if (req.method === "OPTIONS") return send(res, 204, "");

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const authed = token && sessions.has(token);

  try {
    // ---------------- GoTrue ----------------
    if (pathname === "/auth/v1/token") {
      const body = JSON.parse((await readBody(req)).toString() || "{}");
      if (searchParams.get("grant_type") === "refresh_token") {
        const prev = [...sessions.entries()].find(([, s]) => s.refresh === body.refresh_token);
        if (!prev) return send(res, 400, { error: "invalid_grant" });
        sessions.delete(prev[0]);
        const access = crypto.randomUUID();
        const refresh = crypto.randomUUID();
        sessions.set(access, { refresh, user: OWNER });
        return send(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600, user: OWNER });
      }
      if (body.email !== OWNER.email || body.password !== PASSWORD) {
        return send(res, 400, { error_description: "Invalid login credentials" });
      }
      const access = crypto.randomUUID();
      const refresh = crypto.randomUUID();
      sessions.set(access, { refresh, user: OWNER });
      return send(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600, user: OWNER });
    }

    if (pathname === "/auth/v1/user") {
      if (!authed) return send(res, 401, { message: "invalid token" });
      return send(res, 200, OWNER);
    }

    if (pathname === "/auth/v1/logout") {
      if (token) sessions.delete(token);
      return send(res, 204, "");
    }

    // ---------------- PostgREST ----------------
    if (pathname.startsWith("/rest/v1/")) {
      const table = pathname.slice("/rest/v1/".length);
      // Fail closed exactly like the real thing: no token, no data.
      if (!authed) return send(res, 401, { message: "JWT required" });

      if (req.method === "GET") {
        const { cols, embedSql } = selectFrom(searchParams, table);
        const limit = searchParams.get("limit") ? ` limit ${Number(searchParams.get("limit"))}` : "";
        const sql =
          `select ${cols}${embedSql} from public.${table}` +
          whereFrom(searchParams) + orderFrom(searchParams) + limit;
        return send(res, 200, queryJson(sql));
      }

      if (req.method === "POST") {
        const payload = JSON.parse((await readBody(req)).toString() || "{}");
        const rows = Array.isArray(payload) ? payload : [payload];
        if (!rows.length) return send(res, 201, []);
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        const values = rows
          .map((r) => `(${cols.map((c) => lit(r[c] === undefined ? null : r[c])).join(",")})`)
          .join(",");
        const sql =
          `insert into public.${table} (${cols.map(ident).join(",")}) values ${values} returning *`;
        return send(res, 201, queryJsonWrite(sql));
      }

      if (req.method === "PATCH") {
        const payload = JSON.parse((await readBody(req)).toString() || "{}");
        const sets = Object.entries(payload).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(", ");
        if (!sets) return send(res, 200, []);
        const sql = `update public.${table} set ${sets}${whereFrom(searchParams)} returning *`;
        return send(res, 200, queryJsonWrite(sql));
      }

      if (req.method === "DELETE") {
        const sql = `delete from public.${table}${whereFrom(searchParams)} returning *`;
        return send(res, 200, queryJsonWrite(sql));
      }
    }

    // ---------------- Storage ----------------
    if (pathname.startsWith("/storage/v1/object/sign/")) {
      if (!authed) return send(res, 401, { message: "JWT required" });
      const objectPath = pathname.slice("/storage/v1/object/sign/".length);
      const sig = crypto.randomUUID();
      return send(res, 200, { signedURL: `/object/sign/${objectPath}?token=${sig}` });
    }

    if (pathname.startsWith("/storage/v1/object/")) {
      const objectPath = pathname.slice("/storage/v1/object/".length);
      if (req.method === "POST") {
        if (!authed) return send(res, 401, { message: "JWT required" });
        const buf = await readBody(req);
        objects.set(objectPath, { buffer: buf, type: req.headers["content-type"] });
        return send(res, 200, { Key: objectPath });
      }
      if (req.method === "DELETE") {
        if (!authed) return send(res, 401, { message: "JWT required" });
        objects.delete(objectPath);
        return send(res, 200, {});
      }
      if (req.method === "GET") {
        const stored = objects.get(objectPath.replace(/^sign\//, "").split("?")[0]);
        if (!stored) return send(res, 404, { message: "not found" });
        res.writeHead(200, {
          "Content-Type": stored.type || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(stored.buffer);
      }
    }

    return send(res, 404, { message: `no route for ${req.method} ${pathname}` });
  } catch (err) {
    // Surface harness faults loudly; a 500 here means the stand-in is wrong,
    // not that the app is.
    console.error(`[mock-supabase] ${req.method} ${pathname}:`, err.message);
    return send(res, 500, { message: String(err.message) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-supabase listening on http://127.0.0.1:${PORT}`);
  console.log(`  owner: ${OWNER.email}  password: ${PASSWORD}`);
  console.log(`  backed by docker container "${CONTAINER}", database "${DB}"`);
  console.log(`  NOTE: RLS is not enforced here. See 10-rls-assertions.sql for that.`);
});

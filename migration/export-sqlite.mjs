#!/usr/bin/env node
// GapVera SQLite -> Supabase Postgres export.
//
// Reads a COPY of the local SQLite database and emits three artifacts:
//
//   data.sql      idempotent Postgres INSERTs that preserve original integer
//                 ids, wrapped in a single transaction
//   csv/<table>   one CSV per table, for manual import or inspection
//   manifest.json row counts + per-table content checksums, which
//                 reconcile.mjs later re-derives to prove the import matched
//
// Zero dependencies: it shells out to the sqlite3 CLI (-json) rather than
// requiring a native driver, so it runs anywhere without an install step.
//
// The source database is opened read-only (file:...?mode=ro) and never written.
// Per handoff/zero-cost/decisions.md the source SQLite must stay untouched.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Column lists are explicit, not SELECT *, so a schema drift on either side
// surfaces as a loud error here instead of a silently shifted column.
// Order matches supabase/migrations/0001_schema.sql.
export const TABLES = [
  {
    name: "leads",
    columns: [
      "id", "business_name", "owner_name", "phone", "email", "location",
      "industry", "website_status", "website_url", "outreach_status",
      "outreach_channel", "last_contact_date", "next_followup_date", "notes",
      "review_count", "star_rating", "lead_score", "audit_sent", "audit_notes",
      "calls_total", "calls_contacted", "calls_not_interested",
      "calls_voicemail", "calls_booked_demo", "lat", "lng", "audit_report",
      "audit_date", "created_at",
    ],
    numeric: ["id", "review_count", "star_rating", "lead_score", "audit_sent",
      "calls_total", "calls_contacted", "calls_not_interested",
      "calls_voicemail", "calls_booked_demo", "lat", "lng"],
  },
  {
    name: "clients",
    columns: [
      "id", "lead_id", "business_name", "owner_name", "phone", "email",
      "project_status", "contract_value", "deliverables",
      "website_adjustments", "start_date", "due_date", "notes", "created_at",
    ],
    numeric: ["id", "lead_id", "contract_value"],
  },
  {
    name: "calls",
    columns: ["id", "lead_id", "outcome", "note", "called_at"],
    numeric: ["id", "lead_id"],
  },
  {
    name: "email_templates",
    columns: ["id", "name", "kind", "subject", "body", "created_at"],
    numeric: ["id"],
  },
  {
    name: "email_logs",
    columns: [
      "id", "lead_id", "template_id", "to_email", "subject", "body", "status",
      "scheduled_for", "sent_at",
    ],
    numeric: ["id", "lead_id", "template_id"],
  },
  {
    name: "documents",
    columns: [
      "id", "client_id", "filename", "stored_name", "mime", "size",
      "uploaded_at",
    ],
    numeric: ["id", "client_id", "size"],
  },
  {
    name: "invoices",
    columns: [
      "id", "client_id", "number", "status", "issue_date", "due_date",
      "line_items", "tax_rate", "payment_instructions", "notes", "paid_date",
      "created_at",
    ],
    numeric: ["id", "client_id", "tax_rate"],
  },
];

// auth_admin / auth_sessions / auth_failures / auth_lockout are deliberately
// NOT exported. The local bcrypt admin hash is replaced by Supabase Auth; a
// password hash has no business being copied into a new identity provider, and
// local session rows are void by definition.
export const EXCLUDED_TABLES = [
  "auth_admin", "auth_sessions", "auth_failures", "auth_lockout",
  "sqlite_sequence",
];

/** Run SQL read-only. `immutable` skips the -shm sidecar (see snapshot()). */
export function query(dbPath, sql, { immutable = false } = {}) {
  // mode=ro is enforced by the URI, so a bug in this script cannot mutate the
  // database. -readonly is passed too; belt and braces on the preserved data.
  const uri = `file:${dbPath}?mode=ro${immutable ? "&immutable=1" : ""}`;
  const out = execFileSync(
    "sqlite3",
    ["-readonly", "-json", uri, sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  ).trim();
  return out ? JSON.parse(out) : [];
}

/**
 * Take a consistent, portable snapshot of the source database.
 *
 * Why this exists rather than fs.copyFileSync: GapVera's SQLite runs in WAL
 * mode. Copying crm.db alone leaves its -wal/-shm sidecars behind, and the
 * resulting file CANNOT be opened read-only elsewhere — SQLite needs to create
 * a -shm for a WAL database and read-only mode refuses, failing with
 * "unable to open database file (14)". A copied-and-moved snapshot would be
 * dead on arrival, which is a terrible property for a rollback artifact.
 *
 * VACUUM INTO instead produces a checkpointed, defragmented, journal_mode=delete
 * database that opens read-only anywhere, and it does so without writing a
 * single byte to the source.
 */
export function snapshot(src, dest) {
  // VACUUM INTO refuses to overwrite, so clear a previous run's artifact.
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(dest + suffix)) fs.unlinkSync(dest + suffix);
  }
  const target = sqlLiteral(path.resolve(dest), false);
  let immutable = false;
  try {
    execFileSync("sqlite3", ["-readonly", `file:${src}?mode=ro`, `VACUUM INTO ${target}`], {
      encoding: "utf8",
    });
  } catch (err) {
    // Error 14 on a WAL source with no sidecars present. immutable=1 tells
    // SQLite the file will not change so it skips the -shm entirely. That
    // assumption only holds with no concurrent writer, so say so out loud
    // rather than quietly producing a possibly-torn snapshot. The
    // integrity_check below is what actually catches a bad read.
    if (!/unable to open database file/.test(String(err.stderr || err.message))) throw err;
    console.warn(
      "warning: source is WAL-mode without sidecars; reading with immutable=1.\n" +
      "         This assumes nothing is writing to it right now."
    );
    immutable = true;
    execFileSync(
      "sqlite3",
      ["-readonly", `file:${src}?mode=ro&immutable=1`, `VACUUM INTO ${target}`],
      { encoding: "utf8" }
    );
  }

  const check = query(dest, "PRAGMA integrity_check");
  const verdict = check[0]?.integrity_check;
  if (verdict !== "ok") {
    throw new Error(`snapshot failed integrity_check: ${JSON.stringify(check)}`);
  }
  return { immutable };
}

/** Postgres literal. Single quotes doubled; E'' used only when needed. */
export function sqlLiteral(value, isNumeric) {
  if (value === null || value === undefined) return "NULL";
  if (isNumeric) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "NULL";
    return String(n);
  }
  const s = String(value);
  const escaped = s.replace(/'/g, "''");
  // A backslash inside a standard_conforming_strings literal is literal, but
  // being explicit with E'' and escaping both metacharacters makes the output
  // correct regardless of the server's standard_conforming_strings setting.
  if (s.includes("\\")) return `E'${escaped.replace(/\\/g, "\\\\")}'`;
  return `'${escaped}'`;
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Checksum of a table's content, independent of row order and of SQL dialect.
 * reconcile.mjs recomputes this from Postgres; an equal digest means every
 * cell of every row survived the round trip.
 */
export function tableChecksum(table, rows) {
  const lines = rows
    .map((r) => table.columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return "\u0000";
      // Numerics are normalized through Number so 0 vs 0.0 vs "0" agree across
      // SQLite's dynamic typing and Postgres's static types.
      return table.numeric.includes(c) ? String(Number(v)) : String(v);
    }).join("\u001f"))
    .sort();
  return createHash("sha256").update(lines.join("\u001e")).digest("hex");
}

function main() {
  const [src, outDir] = process.argv.slice(2);
  if (!src || !outDir) {
    console.error("usage: export-sqlite.mjs <source.db> <out-dir>");
    process.exit(2);
  }
  if (!fs.existsSync(src)) {
    console.error(`source database not found: ${src}`);
    process.exit(2);
  }

  fs.mkdirSync(path.join(outDir, "csv"), { recursive: true });

  // Everything downstream reads the snapshot, never the live source. This is
  // the "migrate only a verified copy" rule enforced in code rather than left
  // to whoever runs the script.
  const snapPath = path.join(outDir, "crm.snapshot.db");
  snapshot(src, snapPath);
  console.log(`snapshot: ${snapPath} (integrity_check ok)`);

  const present = new Set(
    query(snapPath, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name)
  );
  for (const t of TABLES) {
    if (!present.has(t.name)) {
      console.error(`FATAL: source is missing expected table '${t.name}'`);
      process.exit(1);
    }
  }

  const manifest = {
    source: path.resolve(src),
    snapshot: path.resolve(snapPath),
    snapshot_sha256: createHash("sha256").update(fs.readFileSync(snapPath)).digest("hex"),
    generated_at: new Date().toISOString(),
    tables: {},
  };
  const sql = [
    "-- GapVera data migration: SQLite -> Supabase Postgres.",
    "-- Generated by migration/export-sqlite.mjs. Do not edit by hand.",
    "-- Original integer ids are preserved so the copy reconciles 1:1.",
    "--",
    "-- Run AFTER supabase/migrations/0001_schema.sql, as the postgres role",
    "-- (Supabase SQL editor). Re-running is safe: every statement is",
    "-- ON CONFLICT DO NOTHING inside one transaction.",
    "",
    "BEGIN;",
    "",
  ];

  for (const table of TABLES) {
    const rows = query(snapPath, `SELECT ${table.columns.join(", ")} FROM ${table.name} ORDER BY id`);

    manifest.tables[table.name] = {
      row_count: rows.length,
      checksum_sha256: tableChecksum(table, rows),
      max_id: rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0),
      columns: table.columns,
    };

    fs.writeFileSync(
      path.join(outDir, "csv", `${table.name}.csv`),
      [table.columns.join(","), ...rows.map((r) => table.columns.map((c) => csvCell(r[c])).join(","))]
        .join("\n") + "\n"
    );

    sql.push(`-- ${table.name}: ${rows.length} row(s)`);
    if (rows.length === 0) {
      sql.push(`-- (empty in source)`, "");
      continue;
    }
    for (const r of rows) {
      const values = table.columns.map((c) => sqlLiteral(r[c], table.numeric.includes(c)));
      sql.push(
        `INSERT INTO public.${table.name} (${table.columns.join(", ")}) ` +
        `VALUES (${values.join(", ")}) ON CONFLICT (id) DO NOTHING;`
      );
    }
    sql.push("");
  }

  // Identity sequences must be advanced past the imported ids, or the first
  // insert from the app collides with migrated data. This is the single most
  // commonly forgotten step in an id-preserving import.
  sql.push("-- Advance identity sequences past the imported ids.");
  for (const table of TABLES) {
    sql.push(
      `SELECT setval(pg_get_serial_sequence('public.${table.name}', 'id'), ` +
      `GREATEST((SELECT COALESCE(MAX(id), 0) FROM public.${table.name}), 1), true);`
    );
  }
  sql.push("", "COMMIT;", "");

  fs.writeFileSync(path.join(outDir, "data.sql"), sql.join("\n"));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const total = Object.values(manifest.tables).reduce((s, t) => s + t.row_count, 0);
  console.log(`exported ${total} row(s) across ${TABLES.length} table(s) -> ${outDir}`);
  for (const [name, t] of Object.entries(manifest.tables)) {
    console.log(`  ${name.padEnd(16)} ${String(t.row_count).padStart(5)}  ${t.checksum_sha256.slice(0, 16)}`);
  }
  console.log(`excluded (not migrated): ${EXCLUDED_TABLES.join(", ")}`);
}

// Only run as a CLI; importing this file for tests must not execute main().
if (import.meta.url === `file://${process.argv[1]}`) main();

// Tests for the GapVera migration tooling.
//
// Run: node --test migration/
//
// The point of these tests is the NEGATIVE cases. A reconciler that always
// prints OK is worse than none at all, because it manufactures false
// confidence about migrated business data. Each corruption below must be
// caught.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { TABLES, sqlLiteral, csvCell, tableChecksum, EXCLUDED_TABLES, snapshot, query } from "./export-sqlite.mjs";
import { parseCsv, reconcileTable, checkRelationships } from "./reconcile.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXPORT_DIR = path.join(HERE, "export");
const leadsTable = TABLES.find((t) => t.name === "leads");

// The export artifacts are gitignored (they hold real CRM data), so tests run
// against whatever the last export produced. Say so plainly instead of dying
// on a confusing ENOENT deep inside a fixture read.
if (!fs.existsSync(path.join(EXPORT_DIR, "manifest.json"))) {
  console.error(
    "migration/export/manifest.json not found. Generate the fixtures first:\n" +
    "  node migration/export-sqlite.mjs <path-to>/server/crm.db migration/export"
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// SQL literal generation
// ---------------------------------------------------------------------------

test("sqlLiteral escapes embedded single quotes", () => {
  assert.equal(sqlLiteral("O'Brien Plumbing", false), "'O''Brien Plumbing'");
});

test("sqlLiteral uses E'' and doubles backslashes when present", () => {
  // Real audit_report JSON contains \" sequences. Emitting them raw into a
  // standard literal is how a migration silently mangles stored JSON.
  const out = sqlLiteral('{"detail":"\\"Example\\""}', false);
  assert.ok(out.startsWith("E'"), `expected E-string, got ${out}`);
  assert.ok(out.includes("\\\\"), "backslash must be doubled inside E''");
});

test("sqlLiteral renders null and undefined as NULL, not empty string", () => {
  assert.equal(sqlLiteral(null, false), "NULL");
  assert.equal(sqlLiteral(undefined, true), "NULL");
});

test("sqlLiteral never quotes numerics and rejects non-finite values", () => {
  assert.equal(sqlLiteral(25.7617, true), "25.7617");
  assert.equal(sqlLiteral("42", true), "42");
  assert.equal(sqlLiteral(Infinity, true), "NULL");
  assert.equal(sqlLiteral(NaN, true), "NULL");
});

test("sqlLiteral cannot be used to inject a statement", () => {
  const evil = "x'); DROP TABLE public.leads; --";
  const out = sqlLiteral(evil, false);
  // The closing quote of the literal is the only unescaped one: the payload's
  // own quote got doubled, so it cannot terminate the string early.
  assert.equal(out, "'x''); DROP TABLE public.leads; --'");
});

// ---------------------------------------------------------------------------
// CSV round trip
// ---------------------------------------------------------------------------

test("csvCell quotes fields containing commas, quotes, and newlines", () => {
  assert.equal(csvCell("Miami, FL"), '"Miami, FL"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
});

test("parseCsv round-trips the nasty cases csvCell produces", () => {
  const values = ["Miami, FL", 'say "hi"', "line1\nline2", "", "plain"];
  const csv = "a,b,c,d,e\n" + values.map(csvCell).join(",") + "\n";
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ["a", "b", "c", "d", "e"]);
  assert.deepEqual(rows[1], values);
});

test("parseCsv strips a UTF-8 BOM from the first header", () => {
  const rows = parseCsv("\ufeffid,name\n1,x\n");
  assert.equal(rows[0][0], "id");
});

test("parseCsv handles a final row with no trailing newline", () => {
  const rows = parseCsv("id,name\n1,x");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["1", "x"]);
});

// ---------------------------------------------------------------------------
// Checksum behaviour
// ---------------------------------------------------------------------------

test("tableChecksum is order-independent", () => {
  const a = { id: 1, business_name: "A" };
  const b = { id: 2, business_name: "B" };
  assert.equal(tableChecksum(leadsTable, [a, b]), tableChecksum(leadsTable, [b, a]));
});

test("tableChecksum normalizes numeric formatting across dialects", () => {
  // SQLite hands back 4.5; a Postgres CSV says 4.50. Same value, and a
  // reconciler that flagged this would cry wolf on every real migration.
  const sqlite = { id: 1, business_name: "A", star_rating: 4.5, review_count: 63 };
  const postgres = { id: "1", business_name: "A", star_rating: "4.50", review_count: "63" };
  assert.equal(tableChecksum(leadsTable, [sqlite]), tableChecksum(leadsTable, [postgres]));
});

test("tableChecksum distinguishes NULL from empty string", () => {
  const withNull = { id: 1, business_name: "A", audit_notes: null };
  const withEmpty = { id: 1, business_name: "A", audit_notes: "" };
  assert.notEqual(tableChecksum(leadsTable, [withNull]), tableChecksum(leadsTable, [withEmpty]));
});

test("tableChecksum detects a single changed character", () => {
  const before = { id: 1, business_name: "Riverside Plumbing Co" };
  const after = { id: 1, business_name: "Riverside Plumbing C0" };
  assert.notEqual(tableChecksum(leadsTable, [before]), tableChecksum(leadsTable, [after]));
});

// ---------------------------------------------------------------------------
// Reconciliation against the REAL exported artifacts
// ---------------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, "manifest.json"), "utf8"));
const leadsCsv = fs.readFileSync(path.join(EXPORT_DIR, "csv", "leads.csv"), "utf8");

test("a faithful import reconciles", () => {
  // The exported CSV stands in for a perfect Postgres round trip: same rows,
  // same columns, same order.
  const result = reconcileTable(leadsTable, manifest.tables.leads, leadsCsv);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.rowCount, manifest.tables.leads.row_count);
});

test("reconciliation FAILS when a row is missing", () => {
  const lines = leadsCsv.trimEnd().split("\n");
  const result = reconcileTable(leadsTable, manifest.tables.leads, lines.slice(0, -1).join("\n") + "\n");
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("row count")), JSON.stringify(result.problems));
});

test("reconciliation FAILS when a single cell is altered", () => {
  const tampered = leadsCsv.replace("Riverside Plumbing Co", "Riverside Plumbing Inc");
  assert.notEqual(tampered, leadsCsv, "fixture must actually contain the value");
  const result = reconcileTable(leadsTable, manifest.tables.leads, tampered);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("checksum")), JSON.stringify(result.problems));
});

test("reconciliation FAILS when ids are renumbered", () => {
  // The classic broken import: data present, but ids reassigned by the
  // sequence. Relationships would silently point at the wrong businesses.
  const rows = parseCsv(leadsCsv);
  const shifted = [rows[0], ...rows.slice(1).map((r) => [String(Number(r[0]) + 100), ...r.slice(1)])];
  const csv = shifted.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  const result = reconcileTable(leadsTable, manifest.tables.leads, csv);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("max id") || p.includes("checksum")));
});

test("reconciliation FAILS on a column-order mismatch instead of guessing", () => {
  const rows = parseCsv(leadsCsv);
  const swapped = [...rows];
  swapped[0] = [rows[0][1], rows[0][0], ...rows[0].slice(2)];
  const csv = swapped.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  const result = reconcileTable(leadsTable, manifest.tables.leads, csv);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("header mismatch")));
});

test("reconciliation FAILS when duplicate ids appear", () => {
  const rows = parseCsv(leadsCsv);
  const dup = [...rows, rows[1]];
  const csv = dup.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  const result = reconcileTable(leadsTable, manifest.tables.leads, csv);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("duplicate ids")));
});

test("an empty table reconciles only against a zero row count", () => {
  const callsTable = TABLES.find((t) => t.name === "calls");
  const ok = reconcileTable(callsTable, { ...manifest.tables.calls }, "");
  assert.equal(ok.ok, true);
  const bad = reconcileTable(callsTable, { ...manifest.tables.calls, row_count: 3 }, "");
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// Relationship integrity
// ---------------------------------------------------------------------------

test("checkRelationships accepts resolvable foreign keys and NULL/detached ones", () => {
  const problems = checkRelationships({
    leads: [{ id: "1" }, { id: "2" }],
    clients: [{ id: "1", lead_id: "1" }, { id: "2", lead_id: null }],
    calls: [{ id: "1", lead_id: "2" }],
    email_templates: [{ id: "7" }],
    email_logs: [{ id: "1", lead_id: "1", template_id: "7" }],
    documents: [{ id: "1", client_id: "1" }],
    invoices: [{ id: "1", client_id: "2" }],
  });
  assert.deepEqual(problems, []);
});

test("checkRelationships catches an orphaned foreign key", () => {
  const problems = checkRelationships({
    leads: [{ id: "1" }],
    documents: [{ id: "5", client_id: "99" }],
    clients: [],
  });
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("documents.client_id=99"));
});

// ---------------------------------------------------------------------------
// Safety invariants
// ---------------------------------------------------------------------------

test("auth tables are excluded from the migration", () => {
  // The local bcrypt hash and local sessions must not be copied into Supabase
  // Auth; identity is reissued by the provider.
  for (const t of ["auth_admin", "auth_sessions", "auth_failures", "auth_lockout"]) {
    assert.ok(EXCLUDED_TABLES.includes(t), `${t} must be excluded`);
    assert.ok(!TABLES.some((x) => x.name === t), `${t} must not be in TABLES`);
  }
});

test("generated data.sql carries no auth or credential rows", () => {
  const sql = fs.readFileSync(path.join(EXPORT_DIR, "data.sql"), "utf8");
  for (const t of ["auth_admin", "auth_sessions", "password_hash", "service_role"]) {
    assert.ok(!sql.includes(t), `data.sql must not mention ${t}`);
  }
});

test("generated data.sql is transactional and idempotent", () => {
  const sql = fs.readFileSync(path.join(EXPORT_DIR, "data.sql"), "utf8");
  assert.ok(sql.includes("BEGIN;"), "must open a transaction");
  assert.ok(sql.trimEnd().endsWith("COMMIT;"), "must commit at the end");
  const inserts = sql.match(/^INSERT INTO/gm) || [];
  const guarded = sql.match(/ON CONFLICT \(id\) DO NOTHING;$/gm) || [];
  assert.ok(inserts.length > 0, "expected INSERT statements");
  assert.equal(guarded.length, inserts.length, "every INSERT must be conflict-guarded");
});

test("export reads the source database without modifying it", () => {
  // Export from a copy of the real source and assert its bytes are identical
  // afterwards. This is the "do not touch the source" rule, tested.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gapvera-mig-"));
  const src = path.join(tmp, "copy.db");
  // Snapshot rather than copyFileSync so the fixture is a valid standalone
  // database regardless of the original's journal mode.
  snapshot(path.join(EXPORT_DIR, "crm.snapshot.db"), src);
  const before = fs.readFileSync(src);
  execFileSync(process.execPath, [path.join(HERE, "export-sqlite.mjs"), src, path.join(tmp, "out")], {
    encoding: "utf8",
  });
  assert.deepEqual(fs.readFileSync(src), before, "source database bytes changed");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("snapshot produces a database that opens read-only after being moved", () => {
  // The WAL trap: a bare file copy of a WAL-mode database cannot be opened
  // read-only elsewhere (SQLite error 14), so a copied rollback artifact would
  // be unusable. VACUUM INTO must yield a portable, self-contained file.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gapvera-snap-"));
  const snapPath = path.join(tmp, "snap.db");
  snapshot(path.join(EXPORT_DIR, "crm.snapshot.db"), snapPath);

  const moved = path.join(tmp, "moved", "elsewhere.db");
  fs.mkdirSync(path.dirname(moved));
  fs.copyFileSync(snapPath, moved);

  assert.ok(!fs.existsSync(snapPath + "-wal"), "snapshot must not need a -wal sidecar");
  const rows = query(moved, "SELECT COUNT(*) AS n FROM leads");
  assert.equal(Number(rows[0].n), manifest.tables.leads.row_count);
  assert.equal(query(moved, "PRAGMA journal_mode")[0].journal_mode, "delete");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("snapshot refuses to emit a corrupt artifact", () => {
  // Feed it a file that is not a database; integrity must fail loudly rather
  // than leaving a plausible-looking but unusable rollback artifact behind.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gapvera-bad-"));
  const bogus = path.join(tmp, "not-a.db");
  fs.writeFileSync(bogus, "this is not a sqlite database");
  assert.throws(() => snapshot(bogus, path.join(tmp, "out.db")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the schema migration gates every CRM table behind is_owner()", () => {
  const schema = fs.readFileSync(path.join(HERE, "..", "supabase", "migrations", "0001_schema.sql"), "utf8");
  for (const t of TABLES) {
    assert.ok(
      new RegExp(`'${t.name}'`).test(schema),
      `${t.name} must appear in the RLS table list`
    );
  }
  assert.ok(schema.includes("enable row level security"), "RLS must be enabled");
  assert.ok(schema.includes("force row level security"), "RLS must be forced");
  assert.ok(schema.includes("revoke all on public.%I from anon"), "anon must be revoked");
  assert.ok(schema.includes("using (public.is_owner()) with check (public.is_owner())"),
    "policies must gate both read and write");
  assert.ok(schema.includes("set search_path = public, pg_catalog"),
    "SECURITY DEFINER function must pin search_path");
});

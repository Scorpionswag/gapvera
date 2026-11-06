#!/usr/bin/env node
// GapVera migration reconciliation (acceptance criterion 4).
//
// Proves a Supabase Postgres import matches the preserved SQLite export —
// row counts, ids, relationships, and every cell — rather than trusting that
// the INSERT script "looked fine".
//
// Usage:
//   node migration/reconcile.mjs <export-dir> <postgres-csv-dir>
//
// <export-dir>       the directory export-sqlite.mjs wrote (needs manifest.json)
// <postgres-csv-dir> one <table>.csv per table, exported FROM Supabase after
//                    the import. In the Supabase SQL editor:
//                      select <columns in manifest order> from public.<table> order by id;
//                    then "Download CSV". Column order must match the manifest;
//                    this script checks the header and refuses to guess.
//
// Exit code 0 only if every table reconciles. Non-zero on any mismatch, so it
// can gate a deployment step.
//
// Zero dependencies: a CSV reader and the same checksum function used on the
// SQLite side. Deliberately NOT a database client — this runs against whatever
// the hosted project actually returns, which is the thing being verified.

import fs from "node:fs";
import path from "node:path";
import { TABLES, tableChecksum } from "./export-sqlite.mjs";

/**
 * RFC4180 CSV parser. Written out rather than split(",") because exported CRM
 * data contains commas, quotes, and embedded newlines (audit_report JSON,
 * multi-line notes) — the exact cases a naive split corrupts into a false
 * mismatch, or worse, a false match.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  // Strip a UTF-8 BOM; spreadsheet exports add one and it would poison the
  // first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  // A final line without a trailing newline still counts.
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Drop trailing blank lines.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

/**
 * Postgres CSV empty cell is ambiguous: it means both NULL and ''. The SQLite
 * side distinguishes them. Resolve using the schema: columns declared NOT NULL
 * DEFAULT '' can only be '', while nullable numerics can only be NULL.
 */
function normalizeCell(raw, column, table) {
  if (raw !== "") return raw;
  if (table.numeric.includes(column)) return null; // nullable numeric (lat/lng/lead_id)
  return ""; // text column, NOT NULL DEFAULT ''
}

export function reconcileTable(table, manifestEntry, csvText) {
  const rows = parseCsv(csvText);
  const problems = [];

  if (!rows.length) {
    return { ok: manifestEntry.row_count === 0, problems: manifestEntry.row_count === 0 ? [] : ["csv is empty but export has rows"], rowCount: 0 };
  }

  const header = rows[0].map((h) => h.trim());
  const expected = manifestEntry.columns;
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    return {
      ok: false,
      rowCount: rows.length - 1,
      problems: [
        `header mismatch\n      expected: ${expected.join(",")}\n      got:      ${header.join(",")}`,
      ],
    };
  }

  const objects = rows.slice(1).map((cells) => {
    const o = {};
    expected.forEach((c, i) => { o[c] = normalizeCell(cells[i] ?? "", c, table); });
    return o;
  });

  if (objects.length !== manifestEntry.row_count) {
    problems.push(`row count: expected ${manifestEntry.row_count}, got ${objects.length}`);
  }

  const ids = objects.map((o) => Number(o.id));
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    problems.push(`duplicate ids present (${ids.length} rows, ${uniqueIds.size} distinct)`);
  }
  const maxId = ids.reduce((m, n) => Math.max(m, n || 0), 0);
  if (objects.length && maxId !== manifestEntry.max_id) {
    problems.push(`max id: expected ${manifestEntry.max_id}, got ${maxId}`);
  }

  const checksum = tableChecksum(table, objects);
  if (checksum !== manifestEntry.checksum_sha256) {
    problems.push(
      `content checksum mismatch\n      expected: ${manifestEntry.checksum_sha256}\n      got:      ${checksum}`
    );
  }

  return { ok: problems.length === 0, problems, rowCount: objects.length, checksum };
}

/** Foreign keys must still point at rows that exist (acceptance: relationships). */
export function checkRelationships(byTable) {
  const problems = [];
  const idsOf = (name) => new Set((byTable[name] || []).map((r) => String(Number(r.id))));
  const edges = [
    ["clients", "lead_id", "leads"],
    ["calls", "lead_id", "leads"],
    ["email_logs", "lead_id", "leads"],
    ["email_logs", "template_id", "email_templates"],
    ["documents", "client_id", "clients"],
    ["invoices", "client_id", "clients"],
  ];
  for (const [child, column, parent] of edges) {
    const parentIds = idsOf(parent);
    for (const row of byTable[child] || []) {
      const v = row[column];
      if (v === null || v === "") continue; // detached by design
      if (!parentIds.has(String(Number(v)))) {
        problems.push(`${child}.${column}=${v} (row id ${row.id}) has no matching ${parent}.id`);
      }
    }
  }
  return problems;
}

function main() {
  const [exportDir, pgDir] = process.argv.slice(2);
  if (!exportDir || !pgDir) {
    console.error("usage: reconcile.mjs <export-dir> <postgres-csv-dir>");
    process.exit(2);
  }
  const manifestPath = path.join(exportDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath} (run export-sqlite.mjs first)`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  console.log(`reconciling against ${path.resolve(pgDir)}`);
  console.log(`export manifest: ${manifest.generated_at}  source: ${manifest.source}\n`);

  let failed = 0;
  const byTable = {};

  for (const table of TABLES) {
    const entry = manifest.tables[table.name];
    const csvPath = path.join(pgDir, `${table.name}.csv`);
    if (!fs.existsSync(csvPath)) {
      // A missing file for an empty table is not evidence of success. Demand it.
      console.log(`  FAIL  ${table.name.padEnd(16)} no CSV exported from Postgres (${csvPath})`);
      failed++;
      continue;
    }
    const result = reconcileTable(table, entry, fs.readFileSync(csvPath, "utf8"));
    if (result.ok) {
      console.log(`  OK    ${table.name.padEnd(16)} ${String(result.rowCount).padStart(5)} row(s)  ${entry.checksum_sha256.slice(0, 16)}`);
      // Re-parse into objects for the relationship pass.
      const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
      byTable[table.name] = rows.slice(1).map((cells) => {
        const o = {};
        entry.columns.forEach((c, i) => { o[c] = normalizeCell(cells[i] ?? "", c, table); });
        return o;
      });
    } else {
      failed++;
      console.log(`  FAIL  ${table.name.padEnd(16)}`);
      for (const p of result.problems) console.log(`      - ${p}`);
    }
  }

  const relProblems = failed === 0 ? checkRelationships(byTable) : [];
  if (relProblems.length) {
    failed++;
    console.log(`\n  FAIL  relationships`);
    for (const p of relProblems) console.log(`      - ${p}`);
  } else if (failed === 0) {
    console.log(`  OK    relationships    all foreign keys resolve`);
  }

  console.log("");
  if (failed) {
    console.log(`RECONCILIATION FAILED — ${failed} problem area(s). The migrated copy does NOT match the export.`);
    process.exit(1);
  }
  const total = Object.values(manifest.tables).reduce((s, t) => s + t.row_count, 0);
  console.log(`RECONCILED — ${total} row(s) across ${TABLES.length} table(s) match the preserved SQLite export.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

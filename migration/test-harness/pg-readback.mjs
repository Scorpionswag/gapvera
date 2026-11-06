// Reads every migrated table back out of Postgres as CSV, in the exact column
// order the SQLite export recorded, so migration/reconcile.mjs can verify the
// migrated copy against the preserved export (acceptance criterion 4).
//
// This is the readback half of the verification. The export side hashed what
// SQLite held; this side hashes what Postgres actually returns. Comparing a
// manifest against itself would prove nothing, which is why the CSV has to
// come out of the destination database.
//
// usage: node migration/test-harness/pg-readback.mjs <container> <db> <out-dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [container, database, outDir] = process.argv.slice(2);
if (!container || !database || !outDir) {
  console.error("usage: pg-readback.mjs <container> <db> <out-dir>");
  process.exit(2);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const manifestPath = path.join(HERE, "..", "export", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

fs.mkdirSync(outDir, { recursive: true });

for (const [table, meta] of Object.entries(manifest.tables)) {
  // Column order comes from the manifest, not from Postgres. A destination
  // that happens to have the columns in a different order must still be
  // compared field-for-field against the source.
  const cols = meta.columns.map((c) => `"${c}"`).join(", ");
  const sql = `\\copy (select ${cols} from public.${table} order by id) to stdout with csv header`;

  const csv = execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-c", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );

  fs.writeFileSync(path.join(outDir, `${table}.csv`), csv);
  // Byte size, not a line count: template bodies contain embedded newlines, so
  // counting lines here would report 25 rows for a 4-row table and look like a
  // migration fault. reconcile.mjs does the real parsing and counting.
  console.log(`${table.padEnd(18)} ${String(csv.length).padStart(7)} bytes  (expected ${meta.row_count} row(s))`);
}

console.log(`\nwrote ${Object.keys(manifest.tables).length} CSV file(s) to ${outDir}`);

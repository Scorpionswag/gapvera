# GapVera migration tooling

Zero-cost hosted migration: SQLite → Supabase Postgres. See
`handoff/zero-cost/` for the approved spec, decisions, and acceptance criteria,
and `migration/STATUS.md` for honest per-criterion status.

## Hard rule

**The source database at `server/crm.db` is never modified.** Both scripts open
it read-only (`mode=ro` plus `-readonly`), and `export-sqlite.mjs` immediately
takes a `VACUUM INTO` snapshot and reads only that. A test asserts the source
bytes are unchanged after a full export run.

## Scripts

Zero npm dependencies — both shell out to the `sqlite3` CLI and use only Node
built-ins, so they run on a clean machine with no install step.

### Export

```sh
node migration/export-sqlite.mjs server/crm.db migration/export
```

Produces, in `migration/export/`:

| Artifact | Purpose |
|---|---|
| `crm.snapshot.db` | Checkpointed, portable snapshot. The rollback artifact. |
| `data.sql` | Idempotent Postgres INSERTs, id-preserving, in one transaction. |
| `csv/<table>.csv` | Per-table CSV for inspection or manual import. |
| `manifest.json` | Row counts, max ids, and per-table content checksums. |

Output is gitignored: it contains real CRM data and a full database copy.

### Verify (acceptance criterion 4)

After importing into Supabase, export each table back out as CSV from the SQL
editor — using the column order recorded in `manifest.json` — then:

```sh
node migration/reconcile.mjs migration/export /path/to/downloaded-csvs
```

Exits non-zero on any mismatch in row count, ids, foreign-key resolution, or
cell content. It recomputes the checksums from what Postgres actually returned,
so a passing run is evidence the copy matches rather than an assertion that it
should.

### Test

```sh
npm run test:migration
```

29 tests. The ones that matter are the negative cases: a reconciler that always
prints OK is worse than none, so there are explicit tests proving it fails on a
missing row, an altered cell, renumbered ids, duplicate ids, a column-order
mismatch, and an orphaned foreign key.

## Design notes

**Why `VACUUM INTO` and not `cp`.** GapVera's SQLite runs in WAL mode. Copying
`crm.db` alone leaves its `-wal`/`-shm` sidecars behind, and the result cannot
be opened read-only elsewhere — SQLite wants to create a `-shm` and read-only
mode refuses, failing with "unable to open database file (14)". A `cp`-based
rollback artifact is dead on arrival. `VACUUM INTO` yields a checkpointed,
self-contained `journal_mode=delete` database that opens anywhere, and writes
nothing to the source. There is a test for this.

**Why checksums and not just row counts.** Row counts catch missing rows and
nothing else. The checksum covers every cell of every row, normalized so
SQLite's dynamic typing and Postgres's static types agree (`4.5` vs `4.50`)
while still distinguishing `NULL` from `''`.

**Why ids are preserved.** `clients.lead_id`, `documents.client_id`, and
`invoices.client_id` all reference them. An import that lets the sequence
reassign ids produces a database that looks complete and has silently
re-pointed relationships at the wrong businesses. `data.sql` inserts explicit
ids and then advances each identity sequence past the imported maximum — the
step whose omission makes the app's first insert collide with migrated data.

**What is not migrated.** `auth_admin`, `auth_sessions`, `auth_failures`,
`auth_lockout`. Identity moves to Supabase Auth; a local bcrypt hash has no
business being copied into a new identity provider, and local session rows are
void by definition. A test asserts `data.sql` mentions none of them.

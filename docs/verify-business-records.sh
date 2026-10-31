#!/bin/bash
# Business-record integrity evidence (acceptance criterion 22): compare the
# pre-change backup against the live database, table by table, using the system
# sqlite3 CLI (the vendored better-sqlite3 binary does not run on this host).
# Make a WAL-aware backup first (plain cp misses uncommitted WAL contents):
#   sqlite3 server/crm.db ".backup /tmp/crm.db.pre-auth"
# Then: bash docs/verify-business-records.sh /tmp/crm.db.pre-auth
#
# Keep backups OUTSIDE the repo — crm.db is gitignored, a copy under docs/
# would not be, and it contains real lead contact details.
set -u
LIVE="/Users/erikguzman/gapvera/server/crm.db"
BACKUP="$1"

echo "table | live_rows | backup_rows | live_digest | backup_digest"
for t in leads clients invoices documents calls email_logs email_templates; do
  ln=$(sqlite3 "$LIVE" "SELECT COUNT(*) FROM $t;" 2>/dev/null)
  bn=$(sqlite3 "$BACKUP" "SELECT COUNT(*) FROM $t;" 2>/dev/null)
  ld=$(sqlite3 "$LIVE" "SELECT * FROM $t;" 2>/dev/null | shasum -a 256 | cut -c1-16)
  bd=$(sqlite3 "$BACKUP" "SELECT * FROM $t;" 2>/dev/null | shasum -a 256 | cut -c1-16)
  flag=""
  [ "$ln" != "$bn" ] && flag="  <-- ROW COUNT CHANGED"
  [ "$ld" != "$bd" ] && flag="$flag  <-- CONTENT CHANGED"
  echo "$t | $ln | $bn | $ld | $bd$flag"
done

echo
echo "tables in live db:"
sqlite3 "$LIVE" ".tables"

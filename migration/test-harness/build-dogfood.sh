#!/bin/sh
# Build the client pointed at the local dogfood stub instead of production.
#
# Separate from build-debug.sh because the dogfood pass needs the REAL
# production-shaped bundle (minified, same code path as what ships), just with
# VITE_SUPABASE_* aimed at the local stub. The output goes to dist-dogfood/ so
# it can never be mistaken for, or deployed as, client/dist.
#
# Usage: migration/test-harness/build-dogfood.sh [port]
set -e
PORT="${1:-8811}"
cd "$(dirname "$0")/../../client"
VITE_SUPABASE_URL="http://localhost:${PORT}" \
VITE_SUPABASE_ANON_KEY="sb_publishable_stub" \
  npx vite build --outDir dist-dogfood --logLevel warn
echo "built client/dist-dogfood pointing at http://localhost:${PORT}"

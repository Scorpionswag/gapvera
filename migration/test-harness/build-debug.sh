#!/bin/sh
# Unminified build with sourcemaps, for reading real stack traces during the
# local dogfood pass. Production builds use `npm run build`.
cd "$(dirname "$0")/../../client" || exit 1
exec npx vite build --mode development --minify false --sourcemap --logLevel warn

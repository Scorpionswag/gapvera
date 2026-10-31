#!/bin/bash
# GapVera launcher for macOS. Double-click it in Finder.
#
# Mirrors gapvera-start.cmd (the Windows launcher): runs from wherever this file
# lives, refuses to start a second copy, installs dependencies on first run, and
# treats this Terminal window as the off switch.

set -u

APP_PORT=3001   # Express API. Deliberately not PORT; see .env.example.
WEB_PORT=5173   # Vite dev server, the one you actually open.
URL="http://localhost:${WEB_PORT}"

# Run from this script's own directory so the folder can be moved anywhere.
cd "$(dirname "$0")" || { echo "Could not find the GapVera folder."; read -r -p "Press Return to close."; exit 1; }

printf '\n  GapVera\n  %s\n\n' "$(pwd)"

# If it is already running, just open it rather than starting a second copy.
if lsof -nP -iTCP:"${APP_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  Already running - opening it."
  open "${URL}"
  sleep 1
  exit 0
fi

# Node is a hard prerequisite. Fail with something readable, not a stack trace.
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed."
  echo "  Get it from https://nodejs.org (version 18 or newer), then run this again."
  echo ""
  read -r -p "  Press Return to close."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "  Node.js $(node -v) is too old - GapVera needs 18 or newer."
  echo "  Update it at https://nodejs.org, then run this again."
  echo ""
  read -r -p "  Press Return to close."
  exit 1
fi

# First run: pull dependencies.
if [ ! -d "node_modules" ]; then
  echo "  First run: installing dependencies. This takes a minute or two."
  echo ""
  if ! npm install; then
    echo ""
    echo "  Install failed - the error is above."
    read -r -p "  Press Return to close."
    exit 1
  fi
  echo ""
fi

# Shut both servers down when this window closes or Ctrl-C is pressed. Without
# this, closing the Terminal can orphan the node processes and the next launch
# would think GapVera is still running.
DEV_PID=""
cleanup() {
  if [ -n "${DEV_PID}" ] && kill -0 "${DEV_PID}" 2>/dev/null; then
    kill -- "-${DEV_PID}" 2>/dev/null || kill "${DEV_PID}" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM HUP

echo "  Starting GapVera. Your browser opens once it is ready."
echo "  Keep this window open while you work - closing it shuts GapVera down."
echo ""

# Own process group, so cleanup can take the whole tree (concurrently + both servers).
set -m
npm run dev &
DEV_PID=$!
set +m

# Wait for the web server to actually answer instead of guessing with a sleep.
# 60 x 1s; a cold Vite start on first run is the slow case.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${URL}"; then
    open "${URL}"
    break
  fi
  # If the dev server died on startup, stop waiting and show the error.
  if ! kill -0 "${DEV_PID}" 2>/dev/null; then
    echo ""
    echo "  GapVera failed to start - the error is above."
    read -r -p "  Press Return to close."
    exit 1
  fi
  sleep 1
done

# Hand the window over to the dev server's output.
wait "${DEV_PID}"

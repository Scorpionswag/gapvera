// Guard: the Google Maps Platform API key must never be in the client bundle.
//
// This is the one defect this whole architecture exists to prevent, and it is
// a defect that a passing test suite and a clean build would both miss — the
// bundle would simply contain a key, and everything would work, for anyone who
// opened DevTools. So it is checked against the built artifact itself.
//
// Checks, in order of what they would catch:
//   1. The literal key value, read from the local server/.env. The only
//      instance of the real key reachable from this machine.
//   2. Any Google-key-shaped literal (AIza…), in case a different key leaks.
//   3. The Places endpoint, which a browser must never call directly: if the
//      client talks to places.googleapis.com, it is carrying a credential.
//   4. The env var names, which would indicate an import.meta.env read — a
//      VITE_-prefixed Google key would be inlined at build time.
//
// Run: node migration/test-harness/bundle-secret-scan.mjs [dist-dir-or-file]

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2] || 'client/dist';

function filesToScan(path) {
  if (!existsSync(path)) {
    console.error(`nothing to scan at ${path} — run \`npm run build\` first`);
    process.exit(2);
  }
  if (statSync(path).isFile()) return [path];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|css|html|json|map)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path);
  return out;
}

// The real key, if this machine has it. Read into memory and never printed.
let realKey = '';
const envPath = `${process.env.HOME}/gapvera/server/.env`;
if (existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(/^GOOGLE_MAPS_API_KEY=(.*)$/m);
  realKey = (m?.[1] || '').trim().replace(/^["']|["']$/g, '');
}

const files = filesToScan(target);
const failures = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');

  if (realKey && realKey.length > 12 && text.includes(realKey)) {
    // Report the file, never the value.
    failures.push(`${file}: contains the real GOOGLE_MAPS_API_KEY value`);
  }

  const shaped = text.match(/AIza[0-9A-Za-z_-]{30,}/g);
  if (shaped) {
    failures.push(`${file}: contains ${shaped.length} Google-API-key-shaped literal(s)`);
  }

  if (text.includes('places.googleapis.com')) {
    failures.push(
      `${file}: references places.googleapis.com — the browser must call /api/places/search, not Google directly`
    );
  }

  for (const name of ['VITE_GOOGLE_MAPS_API_KEY', 'VITE_GOOGLE_PLACES_API_KEY']) {
    if (text.includes(name)) {
      failures.push(`${file}: references ${name} — a VITE_-prefixed key is inlined into the bundle`);
    }
  }
}

console.log(`scanned ${files.length} built file(s) under ${target}`);
console.log(`real-key comparison: ${realKey ? 'enabled (key read from server/.env)' : 'SKIPPED (no local key available)'}`);

if (failures.length) {
  console.error('\nFAIL — the client bundle must not carry the Google credential:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log('OK — no Google key value, no key-shaped literal, no direct Places endpoint, no VITE_ key name.');

// Static file server with SPA history fallback, for exercising the built
// client locally.
//
// WHY: the app uses BrowserRouter, so a deep link like /outreach is a real
// path. Production hosting handles this via client/public/_redirects
// ("/*  /index.html  200"), which Cloudflare Pages and Netlify honour.
// `python3 -m http.server` does not, so a direct load of any route other than
// "/" 404s and renders a blank page — an artifact of the test server, not of
// the app. This serves the same bundle the way production will.
//
// usage: node migration/test-harness/serve-spa.mjs <dist-dir> [port]

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [distArg, portArg] = process.argv.slice(2);
const DIST = path.resolve(distArg || "client/dist");
const PORT = Number(portArg || 8899);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);

    // Resolve inside DIST and reject anything that escapes it.
    const candidate = path.resolve(path.join(DIST, urlPath));
    const inside = candidate === DIST || candidate.startsWith(DIST + path.sep);

    let file = null;
    if (inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      file = candidate;
    } else {
      // History fallback: unknown paths are client-side routes, so hand back
      // index.html with a 200 and let the router sort it out.
      file = path.join(DIST, "index.html");
    }

    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`serving ${DIST} on http://127.0.0.1:${PORT} (SPA fallback on)`);
  });

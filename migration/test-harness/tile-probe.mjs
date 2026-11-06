// Acceptance criterion 9 probe: does the basemap actually render map imagery,
// with no credential in the request?
//
// Why this exists: a tile server can refuse a keyless request with HTTP 200
// and a placeholder image. That looks like success to curl, to the browser,
// and to Leaflet — the map "loads", it just shows a wall of identical
// placeholder tiles. The only reliable check is to fetch several
// geographically distant tiles and confirm they differ from each other.
//
// usage: node migration/test-harness/tile-probe.mjs

const PLACES = [
  { name: "Miami",   lat: 25.7617, lon: -80.1918 },
  { name: "Hialeah", lat: 25.8576, lon: -80.2781 },
  { name: "Denver",  lat: 39.7392, lon: -104.9903 },
  { name: "Seattle", lat: 47.6062, lon: -122.3321 },
];

const ZOOM = 12;

// Standard slippy-map tile math (Web Mercator).
function tileFor(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

async function sha256(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PROVIDERS = [
  {
    name: "CARTO dark_all (keyless)",
    url: ({ x, y }) => `https://a.basemaps.cartocdn.com/dark_all/${ZOOM}/${x}/${y}.png`,
  },
  {
    name: "OpenStreetMap standard",
    url: ({ x, y }) => `https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`,
  },
];

for (const provider of PROVIDERS) {
  console.log(`\n${provider.name}`);
  const hashes = new Map();

  for (const place of PLACES) {
    const t = tileFor(place.lat, place.lon, ZOOM);
    const url = provider.url(t);
    try {
      const res = await fetch(url, {
        // OSM's tile usage policy requires an identifying User-Agent.
        headers: { "User-Agent": "GapVera/0.1 (acceptance criterion 9 probe)" },
      });
      const buf = await res.arrayBuffer();
      const hash = (await sha256(buf)).slice(0, 16);
      hashes.set(place.name, hash);
      console.log(
        `  ${place.name.padEnd(9)} z${ZOOM}/${t.x}/${t.y}  HTTP ${res.status}  ` +
        `${String(buf.byteLength).padStart(6)} bytes  ${hash}`
      );
    } catch (err) {
      console.log(`  ${place.name.padEnd(9)} FETCH FAILED: ${err.message}`);
    }
  }

  const distinct = new Set(hashes.values()).size;
  if (distinct === 1) {
    console.log(
      `  => FAIL: all ${hashes.size} tiles are byte-identical. ` +
      `The server is returning a placeholder, not map imagery.`
    );
  } else if (distinct < hashes.size) {
    console.log(`  => SUSPECT: only ${distinct} distinct tiles out of ${hashes.size}.`);
  } else {
    console.log(`  => PASS: all ${hashes.size} tiles are distinct real imagery.`);
  }
}

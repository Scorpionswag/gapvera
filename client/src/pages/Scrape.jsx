import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Stars } from "../components/ui.jsx";

// EDIT THESE for your own area. The niches skew old-school local, which is
// where the no-website rates are highest.
const CITY_PRESETS = ["Miami, FL", "Hialeah, FL", "Coral Gables, FL", "Kendall, FL", "Homestead, FL", "Doral, FL"];

// Percentages are measured, not guessed: 244 real Places searches on 2026-08-01
// across 23 cities in 5 states (2,729 businesses). The city field is free text
// and every scraped lead carries its own coordinates, so these hold nationwide.
// "Untested" entries are plausible old-school trades nobody has measured yet.
const NICHE_GROUPS = [
  {
    label: "Strongest gap — 30%+ have no website",
    items: [
      { name: "shoe repair", rate: 50 },
      { name: "sewing and alterations", rate: 49 },
      { name: "welding", rate: 38 },
      { name: "upholstery repair", rate: 33 },
      { name: "appliance repair", rate: 32 },
    ],
  },
  {
    label: "Solid gap — 20-29%",
    items: [
      { name: "lawn care", rate: 28 },
      { name: "handyman", rate: 26 },
      { name: "tree service", rate: 26 },
      { name: "plumbers", rate: 24 },
      { name: "pool service", rate: 23 },
      { name: "salons", rate: 20 },
    ],
  },
  {
    label: "Weak gap — mostly already online",
    items: [
      { name: "screen enclosure repair", rate: 13 },
      { name: "HVAC", rate: 11 },
      { name: "auto detailing", rate: 11 },
      { name: "pet grooming", rate: 10 },
      { name: "pressure washing", rate: 9 },
      { name: "roofers", rate: 7 },
      { name: "septic service", rate: 4 },
    ],
  },
  {
    label: "Untested ideas — measure before you commit",
    items: [
      { name: "small engine repair" }, { name: "watch repair" },
      { name: "furniture repair" }, { name: "locksmith" },
      { name: "muffler shop" }, { name: "transmission repair" },
      { name: "tailor" }, { name: "barber shop" },
      { name: "dry cleaning" }, { name: "vacuum repair" },
      { name: "fence installation" }, { name: "garage door repair" },
      { name: "junk removal" }, { name: "mobile mechanic" },
      { name: "auto glass" }, { name: "window cleaning" },
    ],
  },
];

const ALL_NICHES = NICHE_GROUPS.flatMap((g) => g.items.map((i) => i.name));

export default function Scrape({ refresh, config }) {
  const [niche, setNiche] = useState(() => localStorage.getItem("scrape_niche") || "");
  const [city, setCity] = useState(() => localStorage.getItem("scrape_city") || "");
  const [results, setResults] = useState([]);
  const [checked, setChecked] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => localStorage.setItem("scrape_niche", niche), [niche]);
  useEffect(() => localStorage.setItem("scrape_city", city), [city]);

  async function run() {
    setBusy(true);
    setMessage("");
    try {
      const res = await api.scrape(niche, city);
      setResults(res.results);
      // Pre-select the actual targets: businesses without a website.
      setChecked(Object.fromEntries(res.results.map((r, i) => [i, !r.website_url])));
      if (res.mock) setMessage("Mock results (no Google Maps API key set). Add GOOGLE_MAPS_API_KEY to server/.env for real data.");
    } catch (err) {
      setMessage("Scrape failed: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function importSelected() {
    const rows = results.filter((_, i) => checked[i]);
    if (!rows.length) return;
    setBusy(true);
    try {
      const res = await api.bulkImport(rows);
      setMessage(`Imported ${res.imported} lead(s)${res.skipped ? `, skipped ${res.skipped} already in the database` : ""}.`);
      setResults([]);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = Object.values(checked).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Scrape Leads</h1>
      <p className="text-sm text-dim">Search Google Maps for local businesses — the ones without websites are your pitch list.</p>

      <div className="glass p-4 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[160px]">
          <label className="label">Niche</label>
          <input className="input" placeholder="plumbers, salons, roofers..." value={niche} onChange={(e) => setNiche(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="label">City</label>
          <input className="input" placeholder="Miami, FL" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <button className="btn-primary" disabled={busy || !niche || !city} onClick={run}>
          {busy ? "Searching..." : "Search"}
        </button>
        <div className="w-full">
          <label className="label">Or pick a trade — % is how many had no website</label>
          <select
            className="input"
            // Falls back to the placeholder when the typed niche isn't in the
            // list, so a custom search never shows a wrong selection.
            value={ALL_NICHES.includes(niche) ? niche : ""}
            onChange={(e) => e.target.value && setNiche(e.target.value)}
          >
            <option value="">Choose a trade...</option>
            {NICHE_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.rate === undefined ? i.name : `${i.name} — ${i.rate}% no website`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="w-full flex flex-wrap gap-1.5">
          {CITY_PRESETS.map((c) => (
            <button key={c} className={`btn-ghost !py-0.5 !px-2 text-xs ${city === c ? "!bg-violet/20 text-violet" : ""}`} onClick={() => setCity(c)}>{c}</button>
          ))}
        </div>
      </div>

      {message && <div className="glass p-3 text-sm text-emberhi">{message}</div>}

      {results.length > 0 && (
        <div className="glass p-4 overflow-x-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">{results.length} results</h2>
            <button className="btn-primary" disabled={busy || !selectedCount} onClick={importSelected}>
              Import {selectedCount} Selected
            </button>
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">
                  <input
                    type="checkbox"
                    checked={selectedCount === results.length}
                    onChange={(e) => setChecked(Object.fromEntries(results.map((_, i) => [i, e.target.checked])))}
                  />
                </th>
                <th className="th">Business</th><th className="th">Phone</th><th className="th">Website</th>
                <th className="th">Rating</th><th className="th">Reviews</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="hover:bg-ink/5">
                  <td className="td"><input type="checkbox" checked={!!checked[i]} onChange={(e) => setChecked({ ...checked, [i]: e.target.checked })} /></td>
                  <td className="td font-medium max-w-[260px]">
                    <span className="block truncate" title={r.business_name}>{r.business_name}</span>
                    <span className="block truncate text-xs text-dim font-normal" title={r.location}>{r.location}</span>
                  </td>
                  <td className="td">{r.phone || "-"}</td>
                  <td className="td max-w-[170px]">
                    {r.website_url ? (
                      <a
                        className="block truncate text-ember hover:underline text-xs"
                        href={r.website_url}
                        target="_blank"
                        rel="noreferrer"
                        title={r.website_url}
                      >
                        {r.website_url.replace(/^https?:\/\/(www\.)?/, "").replace(/[/?#].*$/, "")} ↗
                      </a>
                    ) : (
                      <span className="text-mint text-xs font-semibold">NO WEBSITE</span>
                    )}
                  </td>
                  <td className="td"><Stars rating={r.star_rating} /></td>
                  <td className="td">{r.review_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

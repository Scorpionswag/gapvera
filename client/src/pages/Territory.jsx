import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { STATUS_HEX } from "../api.js";
import { Badge } from "../components/ui.jsx";
import LeadModal from "../components/LeadModal.jsx";

// The GIS layer: every lead with coordinates, plotted on a dark basemap.
// Marker color = outreach status; overdue follow-ups pulse coral.
export default function Territory({ leads, refresh }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [selected, setSelected] = useState(null);

  const today = new Date().toISOString().slice(0, 10);
  const placed = leads.filter((l) => l.lat != null && l.lng != null);

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map(mapEl.current, { zoomControl: true, attributionControl: true })
      .setView([25.68, -80.30], 10);

    // OpenStreetMap, not CARTO. As of 25 Sep 2026 CARTO no longer serves
    // raster tiles without an API key, and — worse than a clean failure — a
    // keyless request returns HTTP 200 with a byte-identical "API KEY
    // REQUIRED" placeholder. Verified on 2026-11-06: four tiles from Miami,
    // Hialeah, Denver and Seattle all hashed to cc3f31364a735d9a, while the
    // same four from OSM were distinct real imagery. See
    // migration/test-harness/tile-probe.mjs.
    //
    // The zero-cost constraint rules out a paid basemap key, and OSM's
    // standard tiles are free and need no credential — which also satisfies
    // criterion 9's "no exposed private credential" by having none to expose.
    // The CSS filter restores the dark treatment the design calls for.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      className: "gapvera-basemap-dark",
    }).addTo(map);

    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const lead of placed) {
      const color = STATUS_HEX[lead.outreach_status] || "#8fa3bc";
      const overdue =
        lead.next_followup_date && lead.next_followup_date < today &&
        !["Closed", "Not Interested", "Booked"].includes(lead.outreach_status);
      const icon = L.divIcon({
        className: "",
        html: `<div class="gv-dot ${overdue ? "overdue" : ""}" style="width:14px;height:14px;background:${color};--dot-glow:${color}99"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const m = L.marker([lead.lat, lead.lng], { icon, title: lead.business_name });
      m.on("click", () => setSelected(lead));
      m.addTo(layer);
    }
    if (placed.length) {
      mapRef.current.fitBounds(L.latLngBounds(placed.map((l) => [l.lat, l.lng])).pad(0.2));
    }
  }, [leads]); // eslint-disable-line react-hooks/exhaustive-deps

  const statuses = [...new Set(placed.map((l) => l.outreach_status))];

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl">Territory</h1>
          <p className="text-sm text-dim mt-1">
            {placed.length} of {leads.length} leads placed · click a marker to open the lead · pulsing means overdue follow-up
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {statuses.map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-xs text-dim">
              <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: STATUS_HEX[s], boxShadow: `0 0 6px ${STATUS_HEX[s]}88` }} />
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="glass overflow-hidden p-1.5">
        <div ref={mapEl} className="w-full rounded-xl" style={{ height: "calc(100vh - 220px)", minHeight: 420 }} />
      </div>

      {selected && (
        <div className="text-sm text-dim">
          Selected: <span className="text-ink">{selected.business_name}</span> <Badge>{selected.outreach_status}</Badge>
        </div>
      )}

      <LeadModal lead={selected} onClose={() => setSelected(null)} onSaved={(silent) => { refresh(); if (!silent) setSelected(null); }} />
    </div>
  );
}

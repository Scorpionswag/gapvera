// Lead intake: a live Google Places lookup, and CSV import.
//
// What changed, and why it is not what the old local adapter did
// -------------------------------------------------------------
// Erik authorized chargeable Google Places usage on 2026-11-07, so this page
// now performs a real lookup instead of showing an UNAVAILABLE badge. But a
// lookup is NOT the old "scrape 20 businesses into the pipeline": Google Maps
// Platform Terms 3.2.3(a)/(b) forbid storing or extracting Places content, so
// results are live-only — not saved, not exported, not copied into a lead
// form. See PLACES_POLICY in api.js for the full reasoning.
//
// This page is therefore built to be honest about three things at once:
//   1. The feature works (a real search, real results, Google attribution).
//   2. It costs money (every lookup is a billable request; the remaining
//      allowance is shown BEFORE the button, not after the charge).
//   3. It does less than the name "scrape" implies, and says so where a user
//      would otherwise look for a "save these" button and find none.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, PLACES_POLICY } from "../api.js";
import { parseCsv, rowsToLeads, TEMPLATE_CSV } from "../csvImport.js";

/** Google's required attribution mark for Places content shown off-map. */
function PoweredByGoogle({ logoUrl }) {
  return (
    <img
      src={logoUrl}
      alt="Powered by Google"
      width="59"
      height="18"
      // Never hidden, never recoloured, never obscured — the policy requires
      // the mark stay visible and legible wherever Places content is shown.
      className="shrink-0"
      style={{ opacity: 1 }}
    />
  );
}

function UsageLine({ usage }) {
  if (!usage) return null;
  // An unconfigured deployment has no allowance to report. Showing "25 left"
  // next to a feature that cannot run would be a lie by arithmetic.
  if (usage.configured === false) return null;
  if (usage.available === false && usage.reason === "ledger_unreadable") {
    return (
      <p className="text-xs text-coral mt-1">
        {usage.message} Lookups are paused until GapVera can read its own usage record.
      </p>
    );
  }
  if (usage.usedToday === undefined) return null;
  const left = Math.max(0, (usage.dailyCap ?? 0) - (usage.usedToday ?? 0));
  const monthLeft = Math.max(0, (usage.monthlyCap ?? 0) - (usage.usedThisMonth ?? 0));
  return (
    <p className="text-xs text-dim mt-1">
      <span className={left === 0 ? "text-coral" : ""}>
        {left} of {usage.dailyCap} lookups left today
      </span>
      {" · "}
      {monthLeft} of {usage.monthlyCap} left this month
      {usage.freeTierPerMonth ? (
        <>
          {" · "}
          the monthly cap sits well inside Google's {usage.freeTierPerMonth.toLocaleString()} free
          requests per month for this search type
        </>
      ) : null}
    </p>
  );
}

export default function Scrape({ refresh }) {
  // --- CSV import state (unchanged behaviour) ---
  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  // --- Google lookup state ---
  const [niche, setNiche] = useState("");
  const [city, setCity] = useState("");
  const [usage, setUsage] = useState(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookup, setLookup] = useState(null);
  const [lookupError, setLookupError] = useState("");

  const templateHref = useMemo(
    () => `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`,
    []
  );

  // Ask the server what the allowance is before any button is clickable, so
  // the cost position is on screen before a charge, not after one.
  const loadUsage = useCallback(() => {
    api
      .placesUsage()
      .then(setUsage)
      .catch((err) => {
        // A usage read that fails must not be reported as "0 used". Say the
        // state is unknown and let the lookup path refuse if it must.
        setUsage({ available: false, reason: "unknown", message: err.message });
      });
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const lookupDisabled =
    lookupBusy || !niche.trim() || !city.trim() || (usage ? usage.available === false : false);

  async function doLookup(e) {
    e.preventDefault();
    setLookupError("");
    setLookupBusy(true);
    try {
      const res = await api.placesSearch(niche.trim(), city.trim());
      setLookup(res);
      // The response carries the post-charge allowance, so reflect it rather
      // than re-querying and showing a stale number for a moment.
      if (res.usage) {
        setUsage((prev) => ({
          ...(prev || {}),
          available: true,
          reason: null,
          message: null,
          usedToday: res.usage.usedToday,
          usedThisMonth: res.usage.usedThisMonth,
          dailyCap: res.usage.dailyCap,
          monthlyCap: res.usage.monthlyCap,
          freeTierPerMonth: res.usage.freeTierPerMonth,
        }));
      }
    } catch (err) {
      setLookupError(err.message);
      // A refusal often carries the allowance that caused it (cap reached), so
      // show the real numbers instead of leaving a stale "plenty left".
      if (err.usage) {
        setUsage((prev) => ({ ...(prev || {}), ...err.usage, available: false, reason: err.reason }));
      } else {
        loadUsage();
      }
    } finally {
      setLookupBusy(false);
    }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setResult(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const outcome = rowsToLeads(parseCsv(text));
      if (outcome.missingHeader) {
        setParsed(null);
        setError(
          "That file has no business_name column. The first row must be a header — download the template below to see the expected shape."
        );
        return;
      }
      setParsed(outcome);
    } catch (err) {
      setParsed(null);
      setError(`Could not read that file: ${err.message}`);
    }
  }

  async function doImport() {
    if (!parsed?.leads.length) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.bulkImport(parsed.leads);
      setResult(res);
      setParsed(null);
      setFileName("");
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Add Leads</h1>

      {/* ---------------- Google Places lookup ---------------- */}
      <div className="glass p-4 space-y-3">
        <div>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <h2 className="font-semibold">{PLACES_POLICY.feature}</h2>
            <span
              className="text-xs font-semibold uppercase tracking-wider text-emberhi border border-ember/40
                         rounded px-2 py-0.5 shrink-0"
            >
              Costs money
            </span>
          </div>
          <p className="text-sm text-dim mt-1">{PLACES_POLICY.what}</p>
          <p className="text-sm text-emberhi mt-1">{PLACES_POLICY.cost}</p>
          <UsageLine usage={usage} />
        </div>

        {/* The reduced behaviour, stated before the search box rather than
            discovered afterwards when no "save" button exists. */}
        <ul className="text-xs text-dim space-y-1 border-l-2 border-dim/30 pl-3">
          {PLACES_POLICY.limits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <form onSubmit={doLookup} className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="places-niche" className="label">
              Business type
            </label>
            <input
              id="places-niche"
              className="input w-full"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="plumber"
              maxLength={80}
            />
          </div>
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="places-city" className="label">
              City
            </label>
            <input
              id="places-city"
              className="input w-full"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Hialeah, FL"
              maxLength={80}
            />
          </div>
          <button type="submit" className="btn-primary shrink-0" disabled={lookupDisabled}>
            {lookupBusy ? "Searching Google…" : "Look up (1 billable request)"}
          </button>
        </form>

        {usage?.available === false && usage.message && (
          <div
            role="status"
            className="text-sm text-emberhi border border-ember/30 bg-ember/10 rounded-lg px-3 py-2"
          >
            {usage.message}
          </div>
        )}

        {lookupError && (
          <div role="alert" className="text-sm text-coral border border-coral/30 bg-coral/10 rounded-lg px-3 py-2">
            {lookupError}
          </div>
        )}

        {lookup && (
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm">
                <strong>{lookup.count}</strong> result{lookup.count === 1 ? "" : "s"} for{" "}
                <span className="text-dim">
                  {lookup.query.niche} in {lookup.query.city}
                </span>
              </div>
              {/* Attribution travels with the content it attributes. */}
              <div className="flex items-center gap-2 shrink-0">
                <PoweredByGoogle logoUrl={lookup.attribution.logoUrl} />
              </div>
            </div>

            <p className="text-xs text-dim">{lookup.attribution.notice}</p>

            {lookup.count === 0 ? (
              <div className="text-sm text-dim border border-dim/30 rounded-lg px-3 py-2">
                Google returned no businesses for that search. The request was still billed — try a
                broader business type or a nearby city.
              </div>
            ) : (
              <>
                {/* Visually distinguished from GapVera's own data with its own
                    border and background, per Google's attribution guidelines:
                    Places content must not be mixed indistinguishably with
                    content from other sources. */}
                <div className="overflow-x-auto border border-ember/25 bg-ember/[0.04] rounded-lg">
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        <th className="th">Business</th>
                        <th className="th">Address</th>
                        <th className="th">Phone</th>
                        <th className="th">Rating</th>
                        <th className="th">Website</th>
                        <th className="th">On Google</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lookup.results.map((p) => (
                        <tr key={p.place_id} className="hover:bg-ink/5">
                          <td className="td font-medium max-w-[220px]">
                            <span className="block truncate" title={p.business_name}>
                              {p.business_name}
                            </span>
                            {p.category && <span className="micro block truncate">{p.category}</span>}
                          </td>
                          <td className="td max-w-[200px]">
                            <span className="block truncate" title={p.address}>
                              {p.address || "-"}
                            </span>
                          </td>
                          <td className="td whitespace-nowrap">{p.phone || "-"}</td>
                          <td className="td whitespace-nowrap">
                            {p.rating === null ? (
                              <span className="text-dim/60">-</span>
                            ) : (
                              <>
                                <span className="text-ember">★</span> {p.rating}
                                <span className="text-dim text-xs ml-1">({p.review_count ?? 0})</span>
                              </>
                            )}
                          </td>
                          <td className="td">
                            {p.has_website ? (
                              <a
                                className="text-xs text-dim underline hover:text-ink"
                                href={p.website_url}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                Visit
                              </a>
                            ) : (
                              <span className="text-mint text-xs font-semibold">NO WEBSITE</span>
                            )}
                          </td>
                          <td className="td">
                            {p.google_maps_uri ? (
                              <a
                                className="text-xs underline text-dim hover:text-ink"
                                href={p.google_maps_uri}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                View
                              </a>
                            ) : (
                              <span className="text-dim/60">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Third-party data-provider attributions, when Google sends
                    them. Rendered rather than dropped: the policy requires
                    them to be displayed alongside the content. */}
                {lookup.results.some((p) => p.attributions.length > 0) && (
                  <div className="micro">
                    Data providers:{" "}
                    {[
                      ...new Set(
                        lookup.results.flatMap((p) => p.attributions.map((a) => a.provider))
                      ),
                    ].join(", ")}
                  </div>
                )}

                {/* Where a "Save all to leads" button would be. Its absence is
                    the point, so it is explained rather than left blank. */}
                <div className="text-xs text-dim border border-dim/30 rounded-lg px-3 py-2">
                  There is no “save these to my leads” button, and that is deliberate: Google's terms
                  let GapVera show you this list but not keep it. Add the businesses you want to work
                  on the <strong>Leads</strong> page as your own entries. Closing this page clears the
                  results.
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ---------------- CSV import (unchanged) ---------------- */}
      <div className="glass p-4 space-y-3">
        <div>
          <h2 className="font-semibold">Import a CSV</h2>
          <p className="text-sm text-dim mt-1">
            One row per business. <code className="text-xs">business_name</code> is required;
            everything else is optional. Leads already on file with the same name and location are
            skipped, so re-importing the same file adds nothing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="btn-primary cursor-pointer">
            Choose CSV file
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
          </label>
          <a className="btn-ghost text-xs" href={templateHref} download="gapvera-leads-template.csv">
            Download template
          </a>
          {fileName && <span className="text-xs text-dim truncate">{fileName}</span>}
        </div>

        {error && (
          <div role="alert" className="text-sm text-coral border border-coral/30 bg-coral/10 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {parsed && (
          <div className="space-y-3 pt-1">
            <div className="text-sm">
              <strong>{parsed.leads.length}</strong> row{parsed.leads.length === 1 ? "" : "s"} ready
              to import.
            </div>

            {parsed.unknownColumns.length > 0 && (
              <div className="text-xs text-emberhi">
                Ignoring unrecognized column{parsed.unknownColumns.length === 1 ? "" : "s"}:{" "}
                {parsed.unknownColumns.join(", ")}
              </div>
            )}

            {parsed.rejected.length > 0 && (
              <div className="text-xs text-coral">
                Skipping {parsed.rejected.length} row{parsed.rejected.length === 1 ? "" : "s"}:{" "}
                {parsed.rejected.slice(0, 5).map((r) => `line ${r.line} (${r.reason})`).join(", ")}
                {parsed.rejected.length > 5 && `, and ${parsed.rejected.length - 5} more`}
              </div>
            )}

            {parsed.leads.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="th">Business</th>
                      <th className="th">Location</th>
                      <th className="th">Phone</th>
                      <th className="th">Website</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.leads.slice(0, 10).map((l, i) => (
                      <tr key={i} className="hover:bg-ink/5">
                        <td className="td font-medium max-w-[240px]">
                          <span className="block truncate" title={l.business_name}>
                            {l.business_name}
                          </span>
                        </td>
                        <td className="td max-w-[180px]">
                          <span className="block truncate">{l.location || "-"}</span>
                        </td>
                        <td className="td">{l.phone || "-"}</td>
                        <td className="td">
                          {l.website_status === "No Website" ? (
                            <span className="text-mint text-xs font-semibold">NO WEBSITE</span>
                          ) : (
                            <span className="text-xs text-dim">{l.website_status}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed.leads.length > 10 && (
                  <div className="micro mt-2">Showing the first 10 of {parsed.leads.length}.</div>
                )}
              </div>
            )}

            <button className="btn-primary" disabled={busy || !parsed.leads.length} onClick={doImport}>
              {busy ? "Importing…" : `Import ${parsed.leads.length} lead${parsed.leads.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}

        {result && (
          <div className="text-sm text-mint border border-mint/30 bg-mint/10 rounded-lg px-3 py-2">
            Imported {result.imported} lead{result.imported === 1 ? "" : "s"}
            {result.skipped ? `, skipped ${result.skipped} already on file` : ""}.
          </div>
        )}
      </div>
    </div>
  );
}

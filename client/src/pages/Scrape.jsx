// Lead intake. Google Places scraping is NOT available in this build, and this
// page says so plainly instead of offering a search box that cannot work
// (acceptance criterion 11: "visibly marked unavailable... no fake success").
//
// What replaces it: manual entry on the Leads page, and the CSV import below.
// The import is deliberately strict about telling you what it did and did not
// take — a silent partial import is how a prospect list quietly loses rows.

import { useMemo, useState } from "react";
import { api, UNAVAILABLE } from "../api.js";
import { parseCsv, rowsToLeads, TEMPLATE_CSV } from "../csvImport.js";

export default function Scrape({ refresh }) {
  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const scrapeInfo = UNAVAILABLE.scrape;

  const templateHref = useMemo(
    () => `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`,
    []
  );

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

      {/* Criterion 11: the disabled capability is named, the reason is real,
          and the alternative is immediately above the tool that does it. */}
      <div className="glass p-4 border border-dim/30">
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 text-xs font-semibold uppercase tracking-wider text-dim border border-dim/40
                       rounded px-2 py-0.5 shrink-0"
          >
            Unavailable
          </span>
          <div className="min-w-0">
            <h2 className="font-semibold">{scrapeInfo.feature}</h2>
            <p className="text-sm text-dim mt-1">{scrapeInfo.reason}</p>
            <p className="text-sm text-ink/80 mt-2">{scrapeInfo.alternative}</p>
          </div>
        </div>
      </div>

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

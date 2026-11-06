// Links to a document in private Supabase Storage.
//
// The bucket is private (acceptance 6), so there is no durable URL to put in
// an href. A signed URL has to be minted per click and is only valid for a
// minute. That makes this a button that fetches-then-navigates, not an anchor.
//
// Why not pre-fetch signed URLs when the list renders: a list of 12 documents
// would mint 12 credentials, 11 of which are never used and all of which
// expire before a slow reader clicks. Minting on demand also means a URL never
// sits in the DOM waiting to be copied out of devtools.

import { useState } from "react";
import { api } from "../api.js";

export function DocLink({ doc, download = false, className = "", title, children }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function open() {
    setBusy(true);
    setFailed(false);
    try {
      const url = await api.docUrl(doc.id, download);
      if (download) {
        // Let the browser handle the save. A temporary anchor is used rather
        // than window.open so the download attribute applies.
        const a = document.createElement("a");
        a.href = url;
        a.download = doc.filename || "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        // noopener: the signed URL must not hand the opened tab a reference
        // back into this authenticated window.
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch {
      // The file is gone, or the session just died. Either way, say so inline
      // rather than opening a tab to an error page.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      title={failed ? "Could not open this file" : title || doc.filename}
      className={`text-left ${failed ? "text-coral" : ""} ${className}`}
    >
      {failed ? "Unavailable" : busy ? "Opening…" : children}
    </button>
  );
}

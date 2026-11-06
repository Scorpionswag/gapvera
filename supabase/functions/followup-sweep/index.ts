// Supabase Edge Function: follow-up sweep.
//
// Invoked by Supabase Cron on a schedule (see supabase/README.md). Short and
// bounded by design — the zero-cost baseline has no long-running server, so
// this must finish fast and be safe to re-run.
//
// IMPORTANT (acceptance 11): automated SMTP is DISABLED in this baseline. This
// job never sends mail. It stages a draft row in email_logs with
// status='draft' and advances nothing that implies a message was delivered.
// Erik reviews and sends manually. A job that "sent" invisible mail while
// marching leads through a sequence would burn the sequence silently, which is
// the exact failure the local build already refused to allow.
//
// Idempotency (acceptance 10): the job claims a run by inserting a durable
// job_runs row keyed on (job, idempotency_key) where the key is the UTC date.
// A duplicate or retried invocation on the same day loses the race against the
// unique index and exits without touching CRM data. At-least-once delivery
// therefore cannot double-apply mutations.
//
// Secrets: reads SUPABASE_SERVICE_ROLE_KEY from the function environment, which
// Supabase injects server-side. It is never echoed, never returned in a
// response, and never present in the browser bundle.

const JOB = "followup-sweep";

interface Lead {
  id: number;
  business_name: string;
  email: string;
  outreach_status: string;
  next_followup_date: string;
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

// Minimal REST helper. The function deliberately does not pull in the JS SDK:
// fewer moving parts in a cron-invoked worker, and no dependency resolution at
// cold start.
async function rest(
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<Response> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(init.prefer ? { Prefer: init.prefer } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

/**
 * Claim today's run. Returns false if another invocation already holds it.
 * The unique index on (job, idempotency_key) is the arbiter — not a read-then-write
 * check, which would race.
 */
async function claim(key: string): Promise<boolean> {
  const res = await rest("job_runs", {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify({ job: JOB, idempotency_key: key, status: "running" }),
  });
  if (res.ok) return true;
  if (res.status === 409) return false; // already claimed; unique violation
  throw new Error(`claim failed: ${res.status} ${await res.text()}`);
}

async function finish(key: string, status: string, detail: unknown): Promise<void> {
  await rest(`job_runs?job=eq.${JOB}&idempotency_key=eq.${encodeURIComponent(key)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, detail, finished_at: new Date().toISOString() }),
  });
}

Deno.serve(async (req: Request) => {
  // UTC date is the idempotency key: one sweep per day regardless of how many
  // times the scheduler fires.
  const key = new Date().toISOString().slice(0, 10);

  try {
    if (!(await claim(key))) {
      // Not an error. The work for today is already accounted for.
      return Response.json(
        { ok: true, skipped: true, reason: "already ran for this period", period: key },
        { status: 200 },
      );
    }
  } catch (err) {
    return Response.json({ ok: false, error: String((err as Error).message) }, { status: 500 });
  }

  try {
    const today = key;
    const res = await rest(
      `leads?select=id,business_name,email,outreach_status,next_followup_date` +
      `&next_followup_date=neq.` +
      `&next_followup_date=lte.${today}` +
      `&outreach_status=in.(Contacted,Follow-Up 1)` +
      `&email=neq.` +
      `&limit=200`,
    );
    if (!res.ok) throw new Error(`lead query failed: ${res.status} ${await res.text()}`);
    const due = (await res.json()) as Lead[];

    const drafted: number[] = [];
    const alreadyStaged: number[] = [];
    for (const lead of due) {
      const kind = lead.outreach_status === "Contacted" ? "followup1" : "followup2";
      const tRes = await rest(`email_templates?select=id,subject,body&kind=eq.${kind}&order=id&limit=1`);
      if (!tRes.ok) continue;
      const [template] = (await tRes.json()) as { id: number; subject: string; body: string }[];
      if (!template) continue;

      // Because this job deliberately does NOT advance outreach_status or
      // next_followup_date (nothing was actually sent), the same lead stays
      // due on every subsequent run. Without this check the sweep would stage
      // a fresh identical draft every single day and the review queue would
      // fill with duplicates of one follow-up. One pending draft per lead per
      // stage is the correct state: it waits until a human acts on it.
      const dupRes = await rest(
        `email_logs?select=id&lead_id=eq.${lead.id}` +
        `&template_id=eq.${template.id}` +
        `&status=eq.draft&limit=1`,
      );
      if (dupRes.ok) {
        const existing = (await dupRes.json()) as { id: number }[];
        if (existing.length) {
          alreadyStaged.push(lead.id);
          continue;
        }
      } else {
        // Could not prove a draft is absent. Skip rather than risk a
        // duplicate: a missed draft is visible and recoverable, an
        // accumulating pile of duplicates is neither.
        continue;
      }

      // status='draft': staged for review, NOT sent. scheduled_for records the
      // date it became due. The lead's outreach_status is deliberately NOT
      // advanced — advancing it here would claim contact that never happened.
      const ins = await rest("email_logs", {
        method: "POST",
        body: JSON.stringify({
          lead_id: lead.id,
          template_id: template.id,
          to_email: lead.email,
          subject: template.subject,
          body: template.body,
          status: "draft",
          scheduled_for: today,
        }),
      });
      if (ins.ok) drafted.push(lead.id);
    }

    const detail = {
      due: due.length,
      drafted: drafted.length,
      already_staged: alreadyStaged.length,
      sent: 0,
      sending_enabled: false,
    };
    await finish(key, "done", detail);
    return Response.json({ ok: true, period: key, ...detail }, { status: 200 });
  } catch (err) {
    const message = String((err as Error).message);
    // Record the failure against the claim so a human can see what happened.
    // The claim is intentionally NOT released: a failed sweep must not be
    // retried blindly on the same day, because partial drafts may exist.
    await finish(key, "failed", { error: message }).catch(() => {});
    return Response.json({ ok: false, period: key, error: message }, { status: 500 });
  }
});

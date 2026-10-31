# GapVera

A sales CRM for selling websites to local businesses. It finds businesses that
have no website, grades the ones that do, runs the calls and emails, maps your
territory, and invoices the work. Everything runs on your own machine and the
data lives in a single file on your disk.

---

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. That is the only
prerequisite.

**Windows:** double-click `gapvera-start.cmd`. It installs dependencies on the
first run and opens the app for you.

**Mac, Linux, or manual:**

```bash
npm install
npm run dev
```

Then open http://localhost:5173

Optional, to fill the app with fake data so it is not empty while you learn it:

```bash
npm run seed
```

Delete those demo leads before you start real work: Leads page, tick the header
checkbox, Delete.

---

## Set it up (about 5 minutes)

1. **Put your name on it.** Edit `client/src/brand.js`. This is the only place
   your name is hard coded, and it appears on the audit reports and invoices
   you send clients.
2. **Set your area.** Edit `CITY_PRESETS` and `NICHE_PRESETS` at the top of
   `client/src/pages/Scrape.jsx` to your own towns and trades. Also update
   `CITY_COORDS` in `server/db.js` and the map centre in
   `client/src/pages/Territory.jsx` so the Territory map opens over your area.
3. **Fix the templates.** Outreach > Manage Templates. Replace `[Your Name]`
   and make the words sound like you. Copy that a stranger wrote is worse than
   plain copy that you wrote.
4. **Optional keys.** Copy `.env.example` to `server/.env` for real Google
   Maps scraping and real email sending. Read that file, it explains both and
   warns about the traps. **Restart GapVera after editing `.env`**, it is only
   read at startup.

---

## The nine pages

| | Page | What it is for |
|---|---|---|
| 01 | Dashboard | Stats plus **Today's Actions**, your ordered hit list for the day |
| 02 | Leads | Every lead. Search, filter, sort, bulk actions, CSV export |
| 03 | Territory | All leads on a map, coloured by stage. Pulsing means overdue |
| 04 | Scrape | Search Google Maps by trade and town, import the results |
| 05 | Outreach | The work session: queue on the left, one lead's calls and email on the right |
| 06 | Pipeline | Drag leads between stages. Stages with work get the space |
| 07 | Follow-Ups | Overdue, due today, upcoming |
| 08 | Clients | Won work: project status, contract value, documents, invoices |
| 09 | Ledger | The money side: outstanding, collected, deadlines, past due |

---

## How a normal day goes

1. **Fill the pipeline.** Scrape a trade and a town. Results with **NO WEBSITE**
   are pre-ticked, because those are the real prospects. Import them.
2. **Work the queue.** Dashboard shows who to contact. Outreach gives you the
   phone button and the outcome buttons. Log what happened after you hang up;
   the pipeline moves itself.
3. **Diagnose the ones who already have a site.** Open the lead, Audit tab, Run
   Diagnostics. You get an A to F grade and a checklist. Every ✗ and ! is a
   thing to say on the call. **Export Report** gives you a clean one-page PDF
   to attach to a reply.
4. **Email with the right pitch.** The composer picks a template based on the
   lead: no website gets one story, a broken site gets another, and the second
   one quotes that lead's own worst finding. Check the preview, hit Send.
5. **Convert and bill.** When they say yes, Convert to Client, then create an
   invoice or use the 50/50 deposit split.

---

## Things worth knowing

- **Google does not publish business email addresses.** Scraped leads arrive
  with a phone number and no email. That is why GapVera is phone-first. For leads
  that have a website, **Find Email** reads their site and offers you any
  addresses it finds.
- **Nothing emails without you.** The hourly follow-up job refuses to run
  unless you set `AUTO_FOLLOWUPS=true`. Leave it off until your templates are
  proven.
- **Calls are events, not counters.** Tapping an outcome opens a small card so
  you can add a note and a follow-up date, then commit. Any logged call can be
  deleted and the totals recalculate. Nothing is one-way.
- **Lead score** out of 100: no website 40, star rating up to 20, review count
  up to 20, email on file 10, phone on file 10. It is opinionated on purpose,
  and it is one function in `server/db.js` if you disagree.
- **Your data** is `server/crm.db`, a single SQLite file, plus uploaded client
  documents in `server/files/`. Back those two up and you have backed up
  everything. Nothing is sent to any server but Google Maps and your own SMTP.

---

## Stack

React + Vite + Tailwind on the front, Express + better-sqlite3 on the back,
Leaflet for the map. No build step to deploy, no account to create, no cloud.

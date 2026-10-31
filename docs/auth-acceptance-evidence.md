# GapVera authentication — acceptance evidence

Maps each applicable criterion from `handoff/acceptance.md` to observed results.
Test run captured in `docs/auth-test-run.txt` (57 tests, 57 pass, 0 fail) via
`npm test -w server`.

Criteria 1–8 are design-review criteria against the static mockup and were
satisfied by the earlier design task; they are not re-verified here.

## Implementation criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 9 | No admin ⇒ setup shown, protected calls disclose nothing; corrupt store fails closed | **Met** | `HTTP: before setup, status says so and business routes still disclose nothing`; `an unreadable auth store throws instead of looking like a fresh install`; `HTTP: an unavailable auth store returns 503, never an open door` |
| 10 | Exactly one admin, atomically; later/concurrent setup fails; refresh does not reopen | **Met** | `first setup creates exactly one admin; every later attempt fails`; `the one-admin limit is a database invariant, not a read-then-write check`; `HTTP: setup closes permanently and does not auto-login` |
| 11 | Remote/untrusted Host rejected; bootstrap state is minimal | **Met** | `HTTP: a non-loopback Host header is refused` (raw socket, 403); `loopback host and address recognition`; `bootstrap status exposes only setup/session state and the password rule` |
| 12 | Server-side length/mismatch rejection; spaces and paste survive | **Met** | `password policy accepts the approved range and rejects outside it`; `spaces are legal and are not trimmed from the secret`; `password length counts code points`; `HTTP: setup rejects mismatch and out-of-policy length with 400` |
| 13 | No plaintext/reversible passwords; no session ids in logs; reviewed salted adaptive hash with documented parameters | **Met** | `stored hash is salted scrypt and reveals nothing of the password`; `the same password hashes differently each time`; `session tokens are stored only as hashes`; parameters documented in `docs/AUTH.md`; source grep found no credential/token logging |
| 14 | Login rotates session id; generic failure; throttle enforced server-side | **Met** | `successful login rotates the session identifier and kills the old one`; `HTTP: login failure is generic and discloses nothing about the account`; `five failures in the window trigger the cooldown`; `HTTP: throttle returns 429 with Retry-After` |
| 15 | Full route inventory: every business read/write, config, export/download, scraper, outreach rejects missing/expired sessions with 401 | **Met (structurally)** | `routes.test.js`: `the gate is installed exactly once`, `every business route is registered after the gate`, `the public surface is exactly the auth bootstrap endpoints`, `the full business inventory is behind the gate, including every mutation and download` (28 enumerated routes). Runtime 401 behavior proven on stand-in routes in `HTTP: every business route rejects an unauthenticated request with 401`. See caveat below. |
| 16 | Client storage/role field/body/badge cannot grant access; authorization from trusted state | **Met** | `HTTP: client-supplied role claims cannot grant access`; `HTTP: role on the request comes from the trusted session record` |
| 17 | Frontend fetches/displays nothing before auth; direct URLs show denied state with no data flash | **Met (by construction)** | `client/src/App.jsx`: the `Workspace` component — which owns every business fetch — is not mounted until the server reports `authenticated: true`. Not browser-tested; see caveat. |
| 18 | Sessions expire at idle/absolute limits and on restart; expired sessions hide cached state | **Met** | `session slides forward on use and dies at the idle limit`; `session dies at the absolute limit however active it has been`; `restart invalidates every outstanding session`; `HTTP: an expired session reports reason 'expired'` |
| 19 | Logout invalidates server session + cookie; replay/other tab/back/refresh cannot retrieve data; failure shows no false success | **Met** | `HTTP: the full login → use → logout → denied cycle` (includes old-cookie replay); `logout invalidates the server session; the old token is dead`; `HTTP: logout failure does not report success` |
| 20 | HttpOnly, SameSite=Strict, Path=/, no Domain; Secure under HTTPS; HTTP confined to loopback | **Met** | `HTTP: session cookie carries HttpOnly, SameSite=Strict, Path=/ and no Domain`; `HTTP: Secure is added when configured for HTTPS`; loopback bind asserted by `the API binds to loopback only` |
| 21 | CSRF rejected on setup/login/logout/mutations; same-origin works; protected responses not publicly cached | **Met** | `HTTP: cross-origin mutations are rejected; same-origin ones proceed` (covers all three auth endpoints); `origin check rejects foreign origins`; `HTTP: protected and auth responses are not publicly cacheable` |
| 22 | Business records unchanged; job behavior preserved; no auth transition starts outreach | **Met** | Pre-change `.backup` compared to live DB — leads 17/17, email_templates 4/4, all seven business tables byte-identical by digest. `the scheduled follow-up job is unchanged by auth and runs outside the request path` asserts the cron schedule and both opt-in guards are untouched. No auth code path calls `sendEmail` or `scrapeLeads`. |
| 23 | Local recovery restores access without default credentials, public reset endpoint, or data loss | **Met** | `server/recover-admin.js`, documented in `docs/AUTH.md`. `recovery: resetting the password keeps exactly one admin and kills sessions`; `recovery: an active lockout does not block the recovered password`; `recovery: there is no HTTP route that can reset a password`; `recovery: setup cannot be reused as a reset once an admin exists` |
| 24 | Evidence maps each criterion including failures/unresolved; no Cloudflare/deployment changes | **This document** | No Cloudflare, deployment, DNS, tunnel or hosting change was made. |

## Caveats — what was NOT executed

One environment problem bounds the verification. `node_modules` on this machine
is quarantined by macOS Gatekeeper (AirDropped) and the vendored
`better-sqlite3` is a Node 22 binary while the host runs Node 26:

```
code signature … not valid for use in process
NODE_MODULE_VERSION 127 … requires 147
```

`npm rebuild better-sqlite3 --build-from-source` fails against Node 26
(better-sqlite3 11.x predates it). Consequences:

1. **`server/index.js` was never booted.** The HTTP tests run against an app
   wired exactly as `index.js` wires it (same `installAuth`, same single
   `app.use("/api", requireAdmin)` gate) with stand-in business routes. That
   the *real* routes sit behind the gate is proven structurally by
   `routes.test.js` reading `index.js`, not by calling all 28 live endpoints.
2. **Criterion 17 was not browser-tested.** The no-data-before-login property
   is structural in `App.jsx` (the fetching component does not mount until the
   server confirms a session) but no browser walkthrough, 390px/1440px layout
   check, or keyboard-focus pass was performed on the new auth screens.
3. **The auth tables do not exist in `crm.db` yet.** They are created on first
   successful server start.
4. **No admin has been created.** Per instruction, no credential was requested
   or created. First run will show setup.

Tests use `node:sqlite` as the database handle. `auth.js` takes its handle as
an argument and uses only the `prepare()`/`exec()` subset both drivers share, so
the code under test is the code the server runs — but it has not been exercised
against `better-sqlite3` itself.

### To clear the caveats

On the machine that will run GapVera:

```
cd /Users/erikguzman/gapvera
xattr -dr com.apple.quarantine node_modules
npm install better-sqlite3@^12 --workspace server
npm test -w server        # expect 57 passing against the real driver
npm run dev               # then walk through first-run setup in a browser
```

Remaining to verify after that: a live first-run setup, the 28 real endpoints
returning 401 while signed out, and the browser/responsive/keyboard pass on the
auth screens.

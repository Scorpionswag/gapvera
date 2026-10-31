# GapVera authentication — implementation notes

One local administrator guards the whole workspace. This document records what
was built, the parameters chosen, the recovery procedure, and what is **not**
covered.

Scope matches the approved increment: local authentication and permissions
only. No Cloudflare migration, deployment, remote exposure, additional users,
OAuth, MFA, or billing.

## What exists

| File | Role |
|---|---|
| `server/auth.js` | Policy core: password hashing, the one-admin invariant, sessions, throttling. Takes a DB handle as an argument. |
| `server/authRoutes.js` | HTTP layer: cookies, loopback/Host enforcement, CSRF, the auth endpoints, and the `requireAdmin` gate. |
| `server/recover-admin.js` | Offline local recovery (see below). |
| `client/src/pages/Auth.jsx` | Setup, login, signed-out and auth-unavailable screens. |
| `client/src/App.jsx` | The gate: the workspace component does not mount until the server confirms a session. |

## Identity and the one-admin invariant

The identity is the fixed string `admin`; there is no user management surface.
Exactly one administrator can exist, and that is enforced by the schema:

```sql
CREATE TABLE auth_admin (id INTEGER PRIMARY KEY CHECK (id = 1), ...)
```

A second `INSERT` fails on the primary key, so two concurrent setup requests
cannot both succeed — the losing one gets a 409. The application's
"does an admin exist?" check is an optimisation, not the guarantee.

## Password storage

scrypt with `N=32768, r=8, p=1`, a 16-byte random salt per hash, 32-byte
output. Stored as `scrypt$N$r$p$salt$hash`; comparison is
`crypto.timingSafeEqual`. Roughly 100 ms per verification — deliberately slow,
and cheap enough that the five-attempt throttle makes it a non-issue as a DoS
lever. `maxmem` is raised to 96 MB because these parameters exceed Node's 32 MB
default.

Passwords are normalised NFKC before hashing so a visually identical passphrase
typed on a different keyboard still matches.

**Policy:** 15–128 characters, spaces allowed, no composition rules. Length is
counted in Unicode code points, so an emoji costs one character rather than
two. Enforced server-side on both setup and recovery; the client check is
convenience only.

## Sessions

Opaque 32-byte random tokens, base64url. The database stores only the SHA-256
of the token, so a stolen database or backup yields nothing replayable as a
cookie.

| Property | Value |
|---|---|
| Idle expiry | 30 minutes, sliding on each request |
| Absolute expiry | 12 hours from login, regardless of activity |
| Restart | All sessions invalidated (`destroyAllSessions()` on boot) |
| Rotation | A successful login mints a new token and destroys the presented one |
| Cookie | `HttpOnly; SameSite=Strict; Path=/`, no `Domain` |

Expiry is evaluated when a token is presented, not by a background sweep, and
the expired row is deleted at that moment.

`Secure` is omitted under this increment's explicit HTTP-loopback operation,
where a Secure cookie would never be sent back. Set
`AUTH_SECURE_COOKIES=true` for any HTTPS deployment — **required** before the
app is served over anything but loopback.

## Login throttling

Five failures within 15 minutes starts a 15-minute cooldown, timed from the
most recent failure. The cooldown is written to `auth_lockout` rather than
derived from the failure window: a derived cooldown releases itself early as
early failures slide out of the window. During a cooldown even the correct
password returns 429 with `Retry-After`.

A successful login clears both the failures and the cooldown.

All login failures — wrong password, wrong username, no admin at all — return
the same 401 body, and the no-admin path still performs a real scrypt
verification against a dummy hash so response time does not disclose which case
it was.

## The permission boundary

`requireAdmin` is mounted **once**, positionally:

```js
app.use("/api", requireAdmin);   // index.js — the gate
```

Everything registered after that line is protected, including endpoints added
in future. Protection is a property of position in the middleware chain, not of
remembering to annotate each route — so the common failure of shipping a new
unprotected endpoint cannot happen. `server/routes.test.js` enforces this by
reading `index.js` and failing if any non-auth route appears above the gate.

The only public endpoints are `/api/auth/status`, `/api/auth/setup`,
`/api/auth/login` and `/api/auth/logout`.

Unauthenticated requests get 401; an authenticated non-admin identity would get
403. The 403 branch is defensive — no second role exists — and role is read
from the trusted session record, never from a request body, header or cookie.

Additional request-level defenses:

- **Loopback only.** Requests not arriving from a loopback address, or carrying
  a non-loopback `Host`, are refused with 403. The listener also binds to
  `127.0.0.1` explicitly.
- **CSRF.** State-changing methods must be same-origin (or from a loopback
  origin, which covers the Vite dev proxy). Applies to setup, login and logout
  as well as business mutations.
- **Caching.** Every API response carries `Cache-Control: no-store, …, private`
  and `Vary: Cookie`, so a signed-out browser cannot re-render business data
  from cache or the back button.

## Fail-closed behavior

If the auth store cannot be read, the answer is "no", never "treat this as a
fresh install":

- `createAuth()` throwing at boot **exits the process**. The server will not
  come up serving business routes unprotected.
- A mid-flight store failure returns 503 from protected routes and from
  `/api/auth/status`. It never returns `setupRequired: true`, which would invite
  an attacker to re-bootstrap a damaged installation.
- A failed logout returns 503 and does **not** report success, while still
  clearing the browser's cookie.
- The client renders an explicit "Authentication is unavailable" screen rather
  than a login form that cannot work.

## Local recovery procedure

There is no email reset, no public reset endpoint, and no default password.
Recovery is an offline, local-operator procedure:

```
cd /Users/erikguzman/gapvera
npm run recover-admin -w server
```

It prompts twice with terminal echo disabled, enforces the same 15–128
character policy, replaces the hash on row 1 (never inserting a second
identity), invalidates every existing session, and clears any active lockout.
Business records are not touched.

Why this is safe: the script has no network surface. Invoking it requires a
shell on this machine with write access to `server/crm.db` — which is already
sufficient to read every record directly. It therefore grants an attacker
nothing they did not already have, while giving the owner a way back in. It
refuses to run without an interactive TTY, so it cannot be piped or scripted.

Full loss of the password with no recovery run available means the database can
still be read with any SQLite tool; local auth protects the application, not the
file. Encrypting the database at rest is out of scope for this increment.

## Running it

First launch shows **01 / Initialize access** and creates `admin`. Setup does
not sign you in: you then log in with the password you chose, which proves the
stored hash verifies. Afterwards setup is permanently closed (409).

```
npm run dev          # both server and client
npm test -w server   # auth and permissions tests (57 tests)
```

Acceptance criteria are mapped to evidence in `docs/auth-acceptance-evidence.md`,
including the four items that remain unverified in this environment.

## Known environment issue (affects verification, not the code)

On this machine `node_modules` was transferred by AirDrop and is quarantined by
macOS Gatekeeper, and the vendored native binaries are built for Node 22 while
the host runs Node 26:

```
better-sqlite3: code signature … not valid for use in process
                NODE_MODULE_VERSION 127 vs required 147
```

`npm rebuild better-sqlite3 --build-from-source` fails against Node 26
(better-sqlite3 11.x predates it). **Consequences:**

1. `server/index.js` could not be booted on this host, so the end-to-end flow
   was verified against an app wired exactly as `index.js` wires it (same
   `installAuth` + same single gate) rather than against `index.js` itself.
2. The auth tables have **not** been created in the real `crm.db` yet; they are
   created on first successful server start.

To fix the environment, on the machine that will run GapVera:

```
cd /Users/erikguzman/gapvera
xattr -dr com.apple.quarantine node_modules     # clear Gatekeeper quarantine
npm install better-sqlite3@^12 --workspace server   # a build supporting Node 26
```

Then run `npm test -w server` and `npm run dev` to confirm the suite and a real
first-run setup.

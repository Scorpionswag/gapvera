// Authentication screens. Copy and structure follow the approved mockup
// (handoff/mockup/auth-flow.html); styling uses the app's existing tokens.
//
// Changed for the hosted build: authentication is Supabase Auth, not a local
// admin password. There is no first-run setup screen any more — the account is
// created in the Supabase dashboard and public signup is disabled, so this app
// offers no way to create one (acceptance 3). The login form therefore takes
// an email address rather than a fixed "admin" username.
//
// These are real password inputs: masked by default with a labeled reveal
// control, they accept paste and never echo a value anywhere but the field.

import { useState } from "react";
import { auth } from "../api.js";

function BrandMark() {
  return (
    <div className="flex items-center justify-center gap-3">
      <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden>
        <defs>
          <linearGradient id="authBrandGrad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#c24b2e" />
            <stop offset="100%" stopColor="#e59374" />
          </linearGradient>
        </defs>
        <path
          d="M7 29 C6 17 12 7 26 5 C27.5 4.8 28 6.5 26.8 7.4 C16 12 12.5 19 11.5 29.2 C11.4 31 7.2 31 7 29 Z"
          fill="url(#authBrandGrad)"
          style={{ filter: "drop-shadow(0 0 8px rgba(194,75,46,0.45))" }}
        />
      </svg>
      <div className="font-display text-2xl font-medium tracking-[0.08em] leading-none">GapVera</div>
    </div>
  );
}

function Shell({ step, title, lede, children }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <BrandMark />
        <div className="glass p-6 md:p-8 mt-6">
          <div className="micro">{step}</div>
          <h1 className="font-display text-2xl mt-2">{title}</h1>
          {lede && <p className="text-sm text-dim mt-2">{lede}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Masked-by-default field with an accessible reveal toggle. */
function PasswordField({ id, label, value, onChange, autoComplete, autoFocus, describedBy }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="mt-4">
      <label htmlFor={id} className="micro block mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          aria-describedby={describedBy}
          className="w-full bg-void/50 border border-ink/15 rounded-lg px-3 py-2 pr-16 text-ink
                     focus:outline-none focus:border-ember/60 focus:ring-1 focus:ring-ember/40"
        />
        <button
          type="button"
          onClick={() => setShown(!shown)}
          aria-pressed={shown}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-dim hover:text-ink
                     px-2 py-1 rounded focus:outline-none focus:ring-1 focus:ring-ember/40"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function Notice({ kind = "error", children }) {
  if (!children) return null;
  const tone =
    kind === "error"
      ? "bg-coral/10 border-coral/30 text-coral"
      : "bg-ember/10 border-ember/30 text-emberhi";
  return (
    <div role="alert" className={`mt-4 text-sm rounded-lg border px-3 py-2 ${tone}`}>
      {children}
    </div>
  );
}

const submitClass =
  "w-full mt-6 rounded-lg px-4 py-2.5 font-medium bg-ember hover:bg-emberhi text-void " +
  "transition-colors disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus:outline-none focus:ring-2 focus:ring-ember/50";

const inputClass =
  "w-full bg-void/50 border border-ink/15 rounded-lg px-3 py-2 text-ink " +
  "focus:outline-none focus:border-ember/60 focus:ring-1 focus:ring-ember/40";

/** Sign in with Supabase Auth. `reason` explains why the screen is showing. */
export function LoginScreen({ reason, onAuthenticated }) {
  const [email, setEmail] = useState(() => localStorage.getItem("gapvera.last_email") || "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const lede =
    reason === "expired"
      ? "Your session expired. Let's sign you back in."
      : reason === "logged-out"
      ? "You're signed out of this workspace."
      : reason === "forbidden"
      ? "That account is not authorized for GapVera."
      : "Sign in to GapVera.";

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await auth.login(email.trim(), password);
      // Remember the address only — never the password. It saves retyping on a
      // phone without storing anything sensitive.
      localStorage.setItem("gapvera.last_email", email.trim());
      setPassword("");
      onAuthenticated();
    } catch (err) {
      setError(err.message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell step="02 / Welcome back" title="Sign in to GapVera." lede={lede}>
      <form onSubmit={submit} noValidate>
        <div className="mt-5">
          <label htmlFor="email" className="micro block mb-1.5">
            Email
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoFocus={!email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus={Boolean(email)}
        />
        <Notice>{error}</Notice>
        <button type="submit" className={submitClass} disabled={busy || !email.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="micro mt-5 leading-relaxed">
        Accounts are created by the administrator in Supabase. Public signup is disabled, so there is
        no register form and no self-service password reset.
      </p>
    </Shell>
  );
}

/** Post-logout confirmation (mockup state 04). */
export function SignedOutScreen({ onBackToLogin }) {
  return (
    <Shell step="04 / Session ended" title="You're logged out." lede="Your session token was discarded.">
      <button type="button" className={submitClass} onClick={onBackToLogin}>
        Back to sign in
      </button>
    </Shell>
  );
}

/** Auth backend unreachable — fail closed, visibly (never a form that can't work). */
export function AuthUnavailableScreen({ onRetry }) {
  return (
    <Shell
      step="Access unavailable"
      title="Authentication is unavailable."
      lede="GapVera cannot reach Supabase to verify access, so the workspace stays locked. Your records are untouched. Check your connection, then try again."
    >
      <button type="button" className={submitClass} onClick={onRetry}>
        Try again
      </button>
    </Shell>
  );
}

/**
 * The build has no Supabase URL/key. This is a deployment fault, not a login
 * problem, and showing a sign-in form here would produce a confusing failure
 * on every attempt — so it gets its own screen that names the missing config.
 */
export function NotConfiguredScreen() {
  return (
    <Shell
      step="Configuration missing"
      title="This build is not connected to a backend."
      lede="GapVera was built without its Supabase credentials, so there is nothing to sign in to."
    >
      <div className="mt-5 text-sm text-dim space-y-2">
        <p>Set both of these as environment variables in the hosting project, then redeploy:</p>
        <pre className="bg-void/50 border border-ink/15 rounded-lg p-3 text-xs overflow-x-auto">
          VITE_SUPABASE_URL{"\n"}VITE_SUPABASE_ANON_KEY
        </pre>
        <p>
          These are build-time values: Vite inlines them when the bundle is compiled, so changing
          them requires a new deployment, not just a page reload.
        </p>
      </div>
    </Shell>
  );
}

/**
 * Signed in, but the account is not the owner. Credentials were correct and
 * authorization is missing — a distinct state from a bad password, and worth
 * saying plainly so nobody retypes a working password repeatedly.
 */
export function NotAuthorizedScreen({ onSignOut }) {
  return (
    <Shell
      step="03 / Not authorized"
      title="This account can't open GapVera."
      lede="Your sign-in worked, but this user is not registered as the workspace owner, so every record stays hidden."
    >
      <p className="micro mt-4 leading-relaxed">
        The owner is granted explicitly in the database. Until then, GapVera correctly shows nothing
        rather than partial data.
      </p>
      <button type="button" className={submitClass} onClick={onSignOut}>
        Sign out
      </button>
    </Shell>
  );
}

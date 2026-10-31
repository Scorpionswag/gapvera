// Authentication screens: first-run setup, login, and the signed-out notice.
// Copy and structure follow the approved mockup (handoff/mockup/auth-flow.html);
// styling uses the app's existing tokens (glass panels, micro labels, ember
// buttons) rather than new ones.
//
// Unlike the mockup these are real password inputs. They are masked by default
// with a labeled reveal control, accept paste, and never echo a value anywhere
// but the field itself.

import { useEffect, useRef, useState } from "react";
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

/** First-run: create the single local administrator. */
export function SetupScreen({ policy, onReady }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const length = [...password].length;
  const lengthOk = length >= policy.min && length <= policy.max;
  const matches = password.length > 0 && password === confirm;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!lengthOk) return setError(`Password must be ${policy.min}–${policy.max} characters.`);
    if (!matches) return setError("Passwords do not match.");
    setBusy(true);
    try {
      await auth.setup(password, confirm);
      // Clear the chosen value from component state before handing off; the
      // operator signs in with it, which also proves the hash verifies.
      setPassword("");
      setConfirm("");
      onReady();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      step="01 / Initialize access"
      title="Make this workspace yours."
      lede="One local administrator protects everything in GapVera. Choose a password you can store in your password manager — there is no email reset."
    >
      <form onSubmit={submit} noValidate>
        <div className="mt-5">
          <div className="micro mb-1.5">Administrator</div>
          <div className="bg-void/50 border border-ink/15 rounded-lg px-3 py-2 text-ink/80">admin</div>
        </div>
        <PasswordField
          id="new-password"
          label="Create password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          autoFocus
          describedBy="password-rule"
        />
        <div id="password-rule" className="micro mt-1.5">
          {policy.min}–{policy.max} characters. Spaces are allowed.
          {password && (
            <span className={lengthOk ? " text-mint" : " text-dim"}>
              {" "}
              · {length} so far
            </span>
          )}
        </div>
        <PasswordField
          id="confirm-password"
          label="Confirm password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
        />
        <Notice>{error}</Notice>
        <button type="submit" className={submitClass} disabled={busy}>
          {busy ? "Creating…" : "Create administrator"}
        </button>
      </form>
    </Shell>
  );
}

/** Sign in. `reason` explains why the login screen is showing. */
export function LoginScreen({ reason, onAuthenticated }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef(null);

  // Mirror the server's cooldown so the button is visibly unavailable. This is
  // display only — the server enforces it regardless of what the UI shows.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    timer.current = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer.current);
  }, [cooldown]);

  const lede =
    reason === "expired"
      ? "Your session expired. Let's sign you back in."
      : reason === "logged-out"
      ? "You're signed out of this workspace."
      : reason === "denied"
      ? "Administrator access is required for that page."
      : "Sign in to GapVera.";

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await auth.login("admin", password);
      setPassword("");
      onAuthenticated();
    } catch (err) {
      if (err.retryAfterSeconds) setCooldown(err.retryAfterSeconds);
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
          <div className="micro mb-1.5">Administrator</div>
          <div className="bg-void/50 border border-ink/15 rounded-lg px-3 py-2 text-ink/80">admin</div>
        </div>
        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
        />
        <Notice>
          {error}
          {cooldown > 0 && (
            <div className="mt-1 text-xs opacity-80">
              Try again in {Math.floor(cooldown / 60)}:{String(cooldown % 60).padStart(2, "0")}.
            </div>
          )}
        </Notice>
        <button type="submit" className={submitClass} disabled={busy || cooldown > 0}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="micro mt-5 leading-relaxed">
        Lost your password? Recovery is a local, offline procedure — see docs/AUTH.md. There is no
        email reset and no default password.
      </p>
    </Shell>
  );
}

/** Post-logout confirmation (mockup state 04). */
export function SignedOutScreen({ onBackToLogin }) {
  return (
    <Shell step="04 / Session ended" title="You're logged out." lede="Your session was ended on the server.">
      <button type="button" className={submitClass} onClick={onBackToLogin}>
        Back to sign in
      </button>
    </Shell>
  );
}

/** Auth store unreachable — fail closed, visibly (never a login form that can't work). */
export function AuthUnavailableScreen({ onRetry }) {
  return (
    <Shell
      step="Access unavailable"
      title="Authentication is unavailable."
      lede="GapVera cannot verify access right now, so the workspace stays locked. Your records are untouched. Check the server log, then try again."
    >
      <button type="button" className={submitClass} onClick={onRetry}>
        Try again
      </button>
    </Shell>
  );
}

import { useEffect, useState, useCallback } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, auth, AUTH_LOST_EVENT, isConfigured } from "./api.js";
import {
  LoginScreen,
  SignedOutScreen,
  AuthUnavailableScreen,
  NotConfiguredScreen,
  NotAuthorizedScreen,
  BackendNotProvisionedScreen,
} from "./pages/Auth.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Leads from "./pages/Leads.jsx";
import Territory from "./pages/Territory.jsx";
import Scrape from "./pages/Scrape.jsx";
import Outreach from "./pages/Outreach.jsx";
import Pipeline from "./pages/Pipeline.jsx";
import FollowUps from "./pages/FollowUps.jsx";
import Clients from "./pages/Clients.jsx";
import Ledger from "./pages/Ledger.jsx";

const NAV = [
  ["/", "Dashboard"],
  ["/leads", "Leads"],
  ["/territory", "Territory"],
  ["/scrape", "Scrape"],
  ["/outreach", "Outreach"],
  ["/pipeline", "Pipeline"],
  ["/followups", "Follow-Ups"],
  ["/clients", "Clients"],
  ["/ledger", "Ledger"],
];

function BrandMark() {
  return (
    <div className="flex items-start gap-3">
      <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden>
        <defs>
          <linearGradient id="brandGrad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#c24b2e" />
            <stop offset="100%" stopColor="#e59374" />
          </linearGradient>
        </defs>
        {/* one clean tapering crescent */}
        <path
          d="M7 29 C6 17 12 7 26 5 C27.5 4.8 28 6.5 26.8 7.4 C16 12 12.5 19 11.5 29.2 C11.4 31 7.2 31 7 29 Z"
          fill="url(#brandGrad)"
          style={{ filter: "drop-shadow(0 0 8px rgba(194,75,46,0.45))" }}
        />
      </svg>
      <div>
        <div className="font-display text-2xl font-medium tracking-[0.08em] leading-none">GapVera</div>
      </div>
    </div>
  );
}

// The gate is a state machine over Supabase's view of the session, and it
// wraps the whole workspace. Business data is fetched by Workspace, which does
// not exist as a component until Supabase has confirmed a live session for an
// account registered as the owner — so "no data before login" is structural,
// not a matter of hiding rendered values.
const PHASE = {
  CHECKING: "checking",
  LOGIN: "login",
  SIGNED_OUT: "signed-out",
  READY: "ready",
  UNAVAILABLE: "unavailable",
  NOT_CONFIGURED: "not-configured",
  NOT_AUTHORIZED: "not-authorized",
  // The build is configured and Supabase answers, but the database has no
  // schema. Distinct from NOT_CONFIGURED (no credentials in the build) and
  // from NOT_AUTHORIZED (schema exists, this account is not the owner).
  NOT_PROVISIONED: "not-provisioned",
};

export default function App() {
  const [phase, setPhase] = useState(PHASE.CHECKING);
  const [loginReason, setLoginReason] = useState(null);

  const checkStatus = useCallback(async () => {
    // A build with no credentials can never authenticate. Say that instead of
    // showing a login form that is guaranteed to fail.
    if (!isConfigured) return setPhase(PHASE.NOT_CONFIGURED);
    setPhase(PHASE.CHECKING);
    try {
      const status = await auth.status();
      if (status.authenticated) return setPhase(PHASE.READY);
      // Checked before the owner branch: with no app_owner table, "not the
      // owner" is unknowable rather than false.
      if (status.backendNotProvisioned) return setPhase(PHASE.NOT_PROVISIONED);
      if (status.authenticatedNotOwner) return setPhase(PHASE.NOT_AUTHORIZED);
      return setPhase(PHASE.LOGIN);
    } catch {
      // Cannot establish whether access is allowed, so assume it is not.
      return setPhase(PHASE.UNAVAILABLE);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Any 401/403 from anywhere in the app tears the workspace down immediately —
  // including a session that expired in another tab or was logged out there.
  useEffect(() => {
    const onAuthLost = (event) => {
      const reason = event.detail?.reason;
      setLoginReason(reason === "expired" || reason === "forbidden" ? reason : null);
      setPhase(PHASE.LOGIN);
    };
    window.addEventListener(AUTH_LOST_EVENT, onAuthLost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, onAuthLost);
  }, []);

  const handleLoggedOut = useCallback(() => {
    setLoginReason("logged-out");
    setPhase(PHASE.SIGNED_OUT);
  }, []);

  switch (phase) {
    case PHASE.CHECKING:
      return (
        <div className="min-h-screen flex items-center justify-center">
          <div className="micro">Checking access…</div>
        </div>
      );
    case PHASE.NOT_CONFIGURED:
      return <NotConfiguredScreen />;
    case PHASE.NOT_PROVISIONED:
      return (
        <BackendNotProvisionedScreen
          onSignOut={async () => {
            await auth.logout();
            setLoginReason(null);
            setPhase(PHASE.LOGIN);
          }}
        />
      );
    case PHASE.UNAVAILABLE:
      return <AuthUnavailableScreen onRetry={checkStatus} />;
    case PHASE.NOT_AUTHORIZED:
      return (
        <NotAuthorizedScreen
          onSignOut={async () => {
            await auth.logout();
            setLoginReason(null);
            setPhase(PHASE.LOGIN);
          }}
        />
      );
    case PHASE.SIGNED_OUT:
      return <SignedOutScreen onBackToLogin={() => setPhase(PHASE.LOGIN)} />;
    case PHASE.LOGIN:
      return (
        <LoginScreen
          reason={loginReason}
          onAuthenticated={() => {
            setLoginReason(null);
            setPhase(PHASE.READY);
          }}
          onBackendNotProvisioned={() => {
            setLoginReason(null);
            setPhase(PHASE.NOT_PROVISIONED);
          }}
        />
      );
    default:
      // Keyed so signing out and back in remounts with empty state rather than
      // reusing the previous session's leads in memory.
      return <Workspace key="workspace" onLoggedOut={handleLoggedOut} />;
  }
}

function Workspace({ onLoggedOut }) {
  const [leads, setLeads] = useState([]);
  const [config, setConfig] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  const refresh = useCallback(
    () => api.leads().then(setLeads).catch((err) => { if (!err.authLost) console.error(err); }),
    []
  );
  useEffect(() => {
    refresh();
    api.config().then(setConfig).catch(() => {});
  }, [refresh]);

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      // Drop protected state before the view changes, so no leads survive in
      // memory into the signed-out render.
      await auth.logout();
      setLeads([]);
      setConfig({});
      onLoggedOut();
    } catch (err) {
      // auth.logout() discards the local token even if the network call fails,
      // so the session really is gone client-side; surface the detail anyway.
      setLeads([]);
      setConfig({});
      setLogoutError(err.message);
      onLoggedOut();
    } finally {
      setLoggingOut(false);
    }
  }

  const ctx = { leads, refresh, config };

  return (
    <div className="min-h-screen md:flex">
      {/* Rail */}
      <aside className={`glass !rounded-none md:!rounded-r-2xl md:w-60 md:min-h-screen p-5 md:fixed md:inset-y-0 z-40 flex-col justify-between ${menuOpen ? "flex" : "hidden md:flex"}`}>
        <div>
          <BrandMark />
          <nav className="space-y-0.5 mt-8">
            {NAV.map(([to, label], i) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `group flex items-baseline gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-ember/10 text-emberhi border border-ember/25"
                      : "text-dim hover:bg-ink/5 hover:text-ink border border-transparent"
                  }`
                }
              >
                <span className="font-display text-[11px] tabular-nums opacity-60">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="space-y-1.5 pt-6">
          <div className="h-px bg-gradient-to-r from-ember/30 to-transparent mb-3" />
          {/* Mockup state 03: the access label and logout live together. This
              badge is a convenience label only — Postgres RLS decides access. */}
          <div className="flex items-center justify-between gap-2">
            <span className="micro truncate" title={auth.user()?.email || ""}>
              {auth.user()?.email || "signed in"}
            </span>
            <button
              type="button"
              className="btn-ghost text-xs px-2 py-1 shrink-0"
              onClick={logout}
              disabled={loggingOut}
            >
              {loggingOut ? "Logging out…" : "Log out"}
            </button>
          </div>
          {logoutError && (
            <div role="alert" className="text-xs text-coral">
              {logoutError}
            </div>
          )}
          <div className="micro">build 0.1.0 · hosted</div>
          {/* These say "unavailable", not "mock": nothing is pretending to
              work in the background. See acceptance criterion 11. */}
          <div className="micro">email sending — unavailable</div>
          {/* Google Places lookup is available as of 2026-11-07 and it costs
              money per lookup, so the rail says so rather than leaving the
              old "unavailable" line to go quietly stale. */}
          <div className="micro">Google lookup — live, billed per search</div>
          <div className="micro">auto-send — off</div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between p-3 sticky top-0 z-30 bg-void/85 backdrop-blur border-b border-ink/10">
        <span className="font-display text-lg tracking-[0.08em]">GapVera</span>
        <button className="btn-ghost" onClick={() => setMenuOpen(!menuOpen)}>☰</button>
      </div>

      {/* min-w-0: without it a flex child's automatic minimum is its content
          width, so any wide page (the pipeline board) stretches main past the
          viewport and scrolls the whole app sideways. */}
      <main className="flex-1 min-w-0 md:ml-60 p-4 md:p-8">
        <Routes>
          <Route path="/" element={<Dashboard {...ctx} />} />
          <Route path="/leads" element={<Leads {...ctx} />} />
          <Route path="/territory" element={<Territory {...ctx} />} />
          <Route path="/scrape" element={<Scrape {...ctx} />} />
          <Route path="/outreach" element={<Outreach {...ctx} />} />
          <Route path="/pipeline" element={<Pipeline {...ctx} />} />
          <Route path="/followups" element={<FollowUps {...ctx} />} />
          <Route path="/clients" element={<Clients {...ctx} />} />
          <Route path="/ledger" element={<Ledger {...ctx} />} />
        </Routes>
      </main>
    </div>
  );
}

import { lazy, Suspense, useEffect, useState } from "react";
import { api, useLive } from "./api";
import { NAV, Shell, type Tab } from "./components/Shell";
import { Approve } from "./pages/Approve";
import { Enroll } from "./pages/Enroll";
import { Login } from "./pages/Login";
import { Network } from "./pages/Network";
import { Overview } from "./pages/Overview";
import { Power } from "./pages/Power";
import { Services } from "./pages/Services";
import { Settings } from "./pages/Settings";
import { Storage } from "./pages/Storage";
import { System } from "./pages/System";
import { Claude } from "./pages/Claude";

// xterm.js is the largest dependency; only load it when the Terminal tab is opened
const Terminal = lazy(() => import("./pages/Terminal").then((m) => ({ default: m.Terminal })));

function tabFromHash(): Tab {
  const h = location.hash.slice(1);
  return NAV.some((n) => n.id === h) ? (h as Tab) : "overview";
}

export default function App() {
  // Pages reached from a QR code or a CLI link, used without a session
  const [, page, arg] = location.pathname.split("/");
  if (page === "approve" && arg) return <Approve id={arg} />;
  if (page === "enroll" && arg) return <Enroll token={arg} />;
  return <Gate />;
}

function Gate() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");

  useEffect(() => {
    api<{ enabled: boolean; authenticated: boolean }>("/api/auth/status")
      .then((s) => setAuth(s.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
    const onRequired = () => setAuth("out");
    window.addEventListener("auth-required", onRequired);
    return () => window.removeEventListener("auth-required", onRequired);
  }, []);

  if (auth === "checking") return null;
  if (auth === "out") return <Login onLogin={() => setAuth("in")} />;
  return <Dashboard onLogout={() => setAuth("out")} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const { live, connected, history } = useLive();

  if (tab === "terminal" && !terminalOpened) setTerminalOpened(true);

  useEffect(() => {
    const onHash = () => {
      setTab(tabFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = `${NAV.find((n) => n.id === tab)?.label} · Lufria Monitor`;
  }, [tab]);

  const logout = () => {
    api("/api/auth/logout", { method: "POST" }).finally(onLogout);
  };

  return (
    <Shell tab={tab} live={live} connected={connected} onLogout={logout}>
      {tab === "overview" && <Overview live={live} history={history} />}
      {tab === "system" && <System live={live} history={history} />}
      {tab === "power" && <Power live={live} history={history} />}
      {tab === "storage" && <Storage live={live} />}
      {tab === "network" && <Network live={live} history={history} />}
      {tab === "services" && <Services />}
      {tab === "settings" && <Settings />}
      {tab === "claude" && <Claude active={tab === "claude"} />}
      {/* Stays mounted once opened, so its shells and scrollback survive switching tabs */}
      {terminalOpened && (
        <div hidden={tab !== "terminal"}>
          <Suspense fallback={null}>
            <Terminal active={tab === "terminal"} />
          </Suspense>
        </div>
      )}
    </Shell>
  );
}

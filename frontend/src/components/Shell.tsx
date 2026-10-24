import type { LucideIcon } from "lucide-react";
import { Bot, Cpu, Gauge, HardDrive, LogOut, Network, Server, Settings, SquareTerminal, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { usePoll, type Live } from "../api";
import { watts } from "../format";

export const NAV = [
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "system", label: "System", icon: Cpu },
  { id: "power", label: "Power", icon: Zap },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "network", label: "Network", icon: Network },
  { id: "services", label: "Services", icon: Server },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "claude", label: "Claude Code", icon: Bot },
  { id: "settings", label: "Settings", icon: Settings },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

export type Tab = (typeof NAV)[number]["id"];

function LiveStatus({ connected }: { connected: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className="relative flex size-2">
        {connected && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60" />}
        <span className={`relative inline-flex size-2 rounded-full ${connected ? "bg-good" : "bg-bad"}`} />
      </span>
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}

function Logo() {
  const { data } = usePoll<{ hostname: string }>("/api/specs");
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="size-8" />
      <div className="leading-tight">
        <div className="text-sm font-semibold">Lufria Monitor</div>
        <div className="font-mono text-[11px] text-muted">{data?.hostname ?? "…"}</div>
      </div>
    </div>
  );
}

export function Shell({ tab, live, connected, onLogout, children, isClaudeRunning = false }: {
  tab: Tab;
  live: Live | null;
  connected: boolean;
  onLogout: () => void;
  children: ReactNode;
  isClaudeRunning?: boolean;
}) {
  return (
    <div className={tab === "claude" ? "flex h-dvh min-h-0 flex-col overflow-hidden" : "min-h-screen"}>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-line bg-bg px-3 py-5 lg:flex">
        <div className="px-2">
          <Logo />
        </div>
        <nav aria-label="Main" className="mt-8 flex flex-col gap-0.5">
          {NAV.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={tab === id ? "page" : undefined}
              className={`flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-150 ${
                tab === id ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface hover:text-fg"
              }`}
            >
              <Icon size={18} aria-hidden className={tab === id ? "text-accent" : ""} />
              <span className="truncate">{label}</span>
              {id === "claude" && isClaudeRunning && (
                <span className="ml-auto flex items-center gap-1.5 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] font-semibold text-accent border border-accent/40 shadow-sm animate-pulse shrink-0">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                    <span className="relative inline-flex size-1.5 rounded-full bg-accent"></span>
                  </span>
                  Running
                </span>
              )}
            </a>
          ))}
        </nav>
        <div className="mt-auto space-y-3 rounded-xl border border-line bg-surface p-3">
          <div className="flex items-center justify-between">
            <LiveStatus connected={connected} />
            <span className="tnum font-mono text-xs text-fg-2">{watts(live?.power.total, 0)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-muted">CPU</div>
              <div className="tnum font-mono text-fg-2">{live ? `${live.cpu.percent.toFixed(0)}%` : "–"}</div>
            </div>
            <div>
              <div className="text-muted">Memory</div>
              <div className="tnum font-mono text-fg-2">{live ? `${live.mem.percent.toFixed(0)}%` : "–"}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onLogout}
            className="flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg text-xs text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
          >
            <LogOut size={14} aria-hidden />
            Log out
          </button>
        </div>
      </aside>

      {/* Mobile top bar + tabs */}
      <header className="monitor-mobile-header sticky top-0 z-20 shrink-0 border-b border-line bg-bg/90 backdrop-blur lg:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Logo />
          <div className="flex items-center gap-1">
            <LiveStatus connected={connected} />
            <button
              type="button"
              onClick={onLogout}
              aria-label="Log out"
              className="grid size-11 cursor-pointer place-items-center rounded-lg text-muted hover:text-fg"
            >
              <LogOut size={18} aria-hidden />
            </button>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={tab === id ? "page" : undefined}
              className={`flex h-11 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm ${
                tab === id ? "bg-surface-2 font-medium text-fg" : "text-muted"
              }`}
            >
              <Icon size={16} aria-hidden className={tab === id ? "text-accent" : ""} />
              {label}
              {id === "claude" && isClaudeRunning && (
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex size-2 rounded-full bg-accent"></span>
                </span>
              )}
            </a>
          ))}
        </nav>
      </header>

      <main className={`min-h-0 flex-1 lg:pl-60 ${tab === "claude" ? "overflow-hidden" : ""}`}>
        {children}
      </main>
    </div>
  );
}

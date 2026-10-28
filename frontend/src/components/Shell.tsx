import type { LucideIcon } from "lucide-react";
import { Bot, Cpu, Gauge, HardDrive, LogOut, Network, PanelLeftClose, PanelLeftOpen, Server, Settings, SquareTerminal, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
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

function LiveStatus({ connected, compact = false }: { connected: boolean; compact?: boolean }) {
  const label = connected ? "Live" : "Reconnecting";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status" title={compact ? label : undefined}>
      <span className="relative flex size-2">
        {connected && <span className="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60" />}
        <span className={`relative inline-flex size-2 rounded-full ${connected ? "bg-good" : "bg-bad"}`} />
      </span>
      <span className={compact ? "sr-only" : undefined}>{label}</span>
    </span>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  const { data } = usePoll<{ hostname: string }>("/api/specs");
  return (
    <div className="flex min-w-0 items-center gap-2.5" title={compact ? `Lufria Monitor · ${data?.hostname ?? ""}` : undefined}>
      <img src="/favicon.svg" alt={compact ? "Lufria Monitor" : ""} className="size-8 shrink-0" />
      {!compact && (
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold">Lufria Monitor</div>
          <div className="truncate font-mono text-[11px] text-muted">{data?.hostname ?? "…"}</div>
        </div>
      )}
    </div>
  );
}

// Desktop sidebar width: drag its edge, or collapse it to an icon rail.
const NAV_WIDTH_KEY = "lufria-nav-width";
const NAV_RAIL = 68;
const NAV_DEFAULT = 240;
const NAV_MAX = 360;
const NAV_COLLAPSE_BELOW = 160;

function loadNavWidth(): number {
  try {
    const n = Number(localStorage.getItem(NAV_WIDTH_KEY));
    return n >= NAV_RAIL && n <= NAV_MAX ? n : NAV_DEFAULT;
  } catch {
    return NAV_DEFAULT;
  }
}

function useNavWidth() {
  const [width, setWidthState] = useState(loadNavWidth);
  const expanded = useRef(width >= NAV_COLLAPSE_BELOW ? width : NAV_DEFAULT);
  const setWidth = useCallback((w: number) => {
    const next = w < NAV_COLLAPSE_BELOW ? NAV_RAIL : Math.min(NAV_MAX, Math.round(w));
    if (next !== NAV_RAIL) expanded.current = next;
    setWidthState(next);
    try { localStorage.setItem(NAV_WIDTH_KEY, String(next)); } catch { /* storage blocked */ }
  }, []);
  const toggle = useCallback(() => setWidth(width === NAV_RAIL ? expanded.current : NAV_RAIL), [setWidth, width]);
  return { width, collapsed: width === NAV_RAIL, setWidth, toggle };
}

function ResizeHandle({ width, onResize, onToggle }: { width: number; onResize: (w: number) => void; onToggle: () => void }) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("is-resizing-nav");
    return () => document.body.classList.remove("is-resizing-nav");
  }, [dragging]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowLeft") onResize(width - step);
    else if (e.key === "ArrowRight") onResize(Math.max(width, NAV_COLLAPSE_BELOW) + step);
    else if (e.key === "Enter" || e.key === " ") onToggle();
    else if (e.key === "Home") onResize(NAV_RAIL);
    else if (e.key === "End") onResize(NAV_MAX);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={NAV_RAIL}
      aria-valuemax={NAV_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to collapse"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => { if (dragging) onResize(e.clientX); }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={onToggle}
      onKeyDown={onKeyDown}
      className={`nav-resize-handle${dragging ? " is-dragging" : ""}`}
    />
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
  const nav = useNavWidth();
  const { collapsed } = nav;

  return (
    <div className={tab === "claude" ? "flex h-dvh min-h-0 flex-col overflow-hidden" : "min-h-screen"}
      style={{ "--nav-w": `${nav.width}px` } as CSSProperties}>
      {/* Desktop sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-20 hidden w-(--nav-w) flex-col border-r border-line bg-bg py-5 lg:flex ${collapsed ? "px-2" : "px-3"}`}>
        <div className={`flex items-center gap-1 ${collapsed ? "flex-col" : "justify-between pl-2"}`}>
          <Logo compact={collapsed} />
          <button type="button" onClick={nav.toggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface hover:text-fg ${collapsed ? "mt-2" : ""}`}>
            {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
          </button>
        </div>
        <nav aria-label="Main" className={`flex flex-col gap-0.5 ${collapsed ? "mt-4" : "mt-8"}`}>
          {NAV.map(({ id, label, icon: Icon }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={tab === id ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              title={collapsed ? label : undefined}
              className={`relative flex h-10 cursor-pointer items-center rounded-lg text-sm transition-colors duration-150 ${
                collapsed ? "justify-center" : "gap-3 px-3"} ${
                tab === id ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface hover:text-fg"
              }`}
            >
              <Icon size={18} aria-hidden className={`shrink-0 ${tab === id ? "text-accent" : ""}`} />
              {!collapsed && <span className="truncate">{label}</span>}
              {id === "claude" && isClaudeRunning && collapsed && (
                <span className="absolute right-2 top-2 flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex size-2 rounded-full bg-accent"></span>
                </span>
              )}
              {id === "claude" && isClaudeRunning && !collapsed && (
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
        {collapsed ? (
          <div className="mt-auto flex flex-col items-center gap-2">
            <LiveStatus connected={connected} compact />
            <span className="tnum font-mono text-[10px] text-fg-2">{watts(live?.power.total, 0)}</span>
            <button type="button" onClick={onLogout} aria-label="Log out" title="Log out"
              className="grid size-10 cursor-pointer place-items-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg">
              <LogOut size={16} aria-hidden />
            </button>
          </div>
        ) : (
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
        )}
        <ResizeHandle width={nav.width} onResize={nav.setWidth} onToggle={nav.toggle} />
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

      <main className={`min-h-0 flex-1 lg:pl-(--nav-w) ${tab === "claude" ? "overflow-hidden" : ""}`}>
        {children}
      </main>
    </div>
  );
}

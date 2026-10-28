import { Gauge, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatAgo } from "./format";
import type { PlanLimits, PlanWindow } from "./types";

const POLL_MS = 60_000; // the server shares one probe per 30 s between every page

/** The official Claude login's plan limits, whatever model the chat uses: read on open, every minute while
 * the page is visible, and live from official turns (`accept`). */
export function usePlanLimits(active: boolean) {
  const [limits, setLimits] = useState<PlanLimits | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);

  // A turn's push can be older than what a poll already brought (replayed to a page that re-attaches).
  const accept = useCallback((raw: unknown) => {
    const next = raw as PlanLimits;
    if (!next || !Array.isArray(next.windows)) return;
    setLimits((prev) => (prev?.fetched_at && next.fetched_at && next.fetched_at < prev.fetched_at ? prev : next));
  }, []);

  const refresh = useCallback(async (force = false) => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      accept(await api<PlanLimits>(`/api/claude/limits${force ? "?refresh=1" : ""}`));
    } catch {
      const error = "Couldn't reach the dashboard server for the plan limits.";
      setLimits((prev) => ({ ...(prev ?? { available: false, subscription: null, windows: [], fetched_at: null, source: null }), error }));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    if (!active) return;
    const visible = () => document.visibilityState === "visible";
    if (visible()) void refresh();
    const timer = setInterval(() => { if (visible()) void refresh(); }, POLL_MS);
    const onVisible = () => { if (visible()) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [active, refresh]);

  return { limits, loading, refresh, accept };
}

/** Re-render on an interval so "resets in" and "updated" stay true. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function formatResets(ts: number | null, now: number): string {
  if (!ts) return "";
  const mins = Math.round((ts * 1000 - now) / 60_000);
  if (mins <= 0) return "resets now";
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function tone(w: PlanWindow): { bar: string; text: string } {
  if (w.severity === "critical") return { bar: "bg-bad", text: "text-bad" };
  if (w.severity === "warning") return { bar: "bg-warn", text: "text-warn" };
  return { bar: "bg-good", text: "text-fg-2" };
}

function resetTitle(w: PlanWindow): string | undefined {
  return w.resets_at ? `Resets ${new Date(w.resets_at * 1000).toLocaleString()}` : undefined;
}

function planName(limits: PlanLimits | null): string | null {
  const s = limits?.subscription;
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

function Meter({ w, now }: { w: PlanWindow; now: number }) {
  const pct = Math.round(w.percent);
  const { bar, text } = tone(w);
  return (
    <div className="mb-2 last:mb-0" title={resetTitle(w)}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="truncate text-muted">{w.label}</span>
        <span className={`shrink-0 font-mono tabular-nums ${text}`}>{pct}%</span>
      </div>
      <div role="meter" aria-label={`${w.label} limit used`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)} aria-valuetext={`${pct}% used${w.resets_at ? `, ${formatResets(w.resets_at, now)}` : ""}`}
        className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full transition-[width] duration-500 ${bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {w.resets_at && <p className="mt-0.5 text-right text-[10px] text-muted">{formatResets(w.resets_at, now)}</p>}
    </div>
  );
}

/** Sidebar panel: always there, filled before the first message and kept current. */
export function PlanLimitsPanel({ limits, loading, onRefresh }: {
  limits: PlanLimits | null; loading: boolean; onRefresh: () => void;
}) {
  const now = useNow(15_000);
  const plan = planName(limits);
  const windows = limits?.windows ?? [];
  const updated = limits?.fetched_at ? formatAgo(limits.fetched_at) : null;

  let body;
  if (!limits) {
    body = (
      <div aria-hidden className="space-y-3 py-1">
        {[0, 1].map((i) => <div key={i} className="space-y-1.5"><div className="h-2.5 w-1/3 rounded bg-surface-2 animate-pulse" /><div className="h-1.5 rounded-full bg-surface-2 animate-pulse" /></div>)}
      </div>
    );
  } else if (windows.length) {
    body = windows.map((w) => <Meter key={w.key} w={w} now={now} />);
  } else if (limits.error) {
    body = <p role="alert" className="text-[11px] leading-relaxed text-bad">{limits.error}</p>;
  } else if (!limits.available) {
    body = <p className="text-[11px] leading-relaxed text-muted">No plan limits: Claude Code signs in with an API key here, which is billed per token.</p>;
  } else {
    body = <p className="text-[11px] leading-relaxed text-muted">Claude Code didn't report any limits yet.</p>;
  }

  return (
    <section aria-labelledby="plan-limits-title" className="shrink-0 border-b border-line px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Gauge size={13} aria-hidden className="shrink-0 text-accent" />
          <h3 id="plan-limits-title" className="truncate text-[11px] font-semibold uppercase tracking-wide text-fg-2">Plan limits</h3>
          {plan && <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] font-medium text-fg-2">{plan}</span>}
        </div>
        <button type="button" onClick={onRefresh} disabled={loading}
          title={`Official Claude Code login, whatever model the chat uses${updated ? ` · updated ${updated}` : ""} · click to refresh`}
          aria-label="Refresh plan limits"
          className="flex min-h-7 shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 text-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-default">
          {updated && <span className="tabular-nums">{updated}</span>}
          <RefreshCw size={11} aria-hidden className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {body}
      {limits?.error && windows.length > 0 && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-warn" title={limits.error}>Couldn't refresh, showing the last reading.</p>
      )}
    </section>
  );
}

/** Toolbar chip for when the sidebar is closed: the first two windows at a glance. */
export function PlanLimitsChip({ limits, onClick }: { limits: PlanLimits | null; onClick: () => void }) {
  const now = useNow(60_000);
  const windows = limits?.windows.slice(0, 2) ?? [];
  if (!windows.length) return null;
  const short = (w: PlanWindow) => (w.key === "five_hour" ? "5h" : w.key === "seven_day" ? "wk" : w.label);
  const title = [`${planName(limits) ?? "Claude"} plan limits (official login)`,
    ...windows.map((w) => `${w.label}: ${Math.round(w.percent)}%${w.resets_at ? `, ${formatResets(w.resets_at, now)}` : ""}`)].join("\n");
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title.replace(/\n/g, ". ")}
      className="agent-limits-chip">
      <Gauge size={13} aria-hidden className="shrink-0 text-muted" />
      {windows.map((w, i) => (
        <span key={w.key} className={i > 0 ? "hidden sm:inline" : undefined}>
          <span className="text-muted">{short(w)}</span> <span className={tone(w).text}>{Math.round(w.percent)}%</span>
        </span>
      ))}
    </button>
  );
}

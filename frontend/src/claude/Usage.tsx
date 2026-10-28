import { BarChart2, Coins, TrendingUp, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatCost, formatTokens } from "./format";

export type UsagePeriod = "today" | "week" | "month" | "all_time";

export interface UsageBucket {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageHistoryItem {
  date: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageResponse {
  summary: {
    today: UsageBucket;
    week: UsageBucket;
    month: UsageBucket;
    all_time: UsageBucket;
  };
  history: UsageHistoryItem[];
  models: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }>;
}

export function UsageHistoryModal({
  usage,
  onClose,
}: {
  usage: UsageResponse;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex="0"]') || []);
    controls()[0]?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key !== "Tab") return;
      const items = controls();
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener("keydown", keydown);
    return () => { dialog?.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="usage-history-title"
        className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-2xl border border-line bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-4 sm:px-6 py-3.5 sm:py-4 bg-surface-2/30">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <Coins className="text-accent size-5 shrink-0" />
            <div className="min-w-0">
              <h2 id="usage-history-title" className="text-sm sm:text-base font-semibold text-fg truncate">Usage & Cost History</h2>
              <p className="text-[11px] sm:text-xs text-muted truncate">Token & cost breakdown across conversations</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close usage history"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3.5 sm:p-6 space-y-4 sm:space-y-6">
          {/* Summary Cards Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Today (Hari Ini)", data: usage.summary.today, highlight: false },
              { label: "This Week (7 Hari)", data: usage.summary.week, highlight: false },
              { label: "This Month (30 Hari)", data: usage.summary.month, highlight: false },
              { label: "All Time (Total)", data: usage.summary.all_time, highlight: true },
            ].map(({ label, data, highlight }) => (
              <div
                key={label}
                className={`rounded-xl border p-3.5 flex flex-col justify-between ${
                  highlight
                    ? "border-accent/40 bg-accent/5"
                    : "border-line bg-surface-2/40"
                }`}
              >
                <div>
                  <span className="text-[11px] font-medium text-muted uppercase tracking-wider">{label}</span>
                  <p className="text-xl font-bold font-mono text-fg mt-1">
                    {formatCost(data.cost_usd)}
                  </p>
                </div>
                <div className="mt-3 pt-2.5 border-t border-line/60 flex items-center justify-between text-xs">
                  <span className="text-muted">{data.sessions} sesi</span>
                  <span className="font-mono text-fg-2">{formatTokens(data.total_tokens)} tok</span>
                </div>
              </div>
            ))}
          </div>

          {/* Daily History Table */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BarChart2 size={16} className="text-accent" />
                <h3 className="text-sm font-semibold text-fg">Riwayat Harian (Daily History)</h3>
              </div>
              <span className="text-xs text-muted">{usage.history.length} hari tercatat</span>
            </div>

            <div className="rounded-xl border border-line overflow-hidden bg-bg/50">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2/60 text-muted border-b border-line text-[11px] font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Tanggal</th>
                      <th className="px-3 py-3 text-center">Sesi</th>
                      <th className="px-3 py-3 text-right">Input Tok</th>
                      <th className="px-3 py-3 text-right">Output Tok</th>
                      <th className="px-3 py-3 text-right">Cache Read</th>
                      <th className="px-3 py-3 text-right">Total Tok</th>
                      <th className="px-4 py-3 text-right">Est. Biaya</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60 font-mono">
                    {usage.history.map((row) => (
                      <tr key={row.date} className="hover:bg-surface-2/40 transition-colors">
                        <td className="px-4 py-2.5 font-sans font-medium text-fg flex items-center gap-2">
                          <span>{row.date}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center text-muted">{row.sessions}</td>
                        <td className="px-3 py-2.5 text-right text-muted">{formatTokens(row.input_tokens)}</td>
                        <td className="px-3 py-2.5 text-right text-muted">{formatTokens(row.output_tokens)}</td>
                        <td className="px-3 py-2.5 text-right text-muted">{formatTokens(row.cache_read_tokens)}</td>
                        <td className="px-3 py-2.5 text-right text-fg-2 font-medium">{formatTokens(row.total_tokens)}</td>
                        <td className="px-4 py-2.5 text-right text-accent font-semibold">{formatCost(row.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* AI Model Breakdown */}
          {Object.keys(usage.models).length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp size={16} className="text-accent" />
                <h3 className="text-sm font-semibold text-fg">Breakdown Model AI</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                {Object.entries(usage.models).map(([model, info]) => (
                  <div key={model} className="rounded-xl border border-line bg-surface-2/30 p-3">
                    <p className="text-xs font-semibold text-fg truncate">{model}</p>
                    <p className="text-base font-bold font-mono text-accent mt-1">{formatCost(info.cost_usd)}</p>
                    <div className="mt-2 text-[10px] text-muted space-y-0.5 font-mono">
                      <p>In: {formatTokens(info.input_tokens)} tok</p>
                      <p>Out: {formatTokens(info.output_tokens)} tok</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function UsageWidget({
  usage,
  activePeriod,
  onChangePeriod,
  onOpenHistory,
}: {
  usage: UsageResponse | null;
  activePeriod: UsagePeriod;
  onChangePeriod: (p: UsagePeriod) => void;
  onOpenHistory: () => void;
}) {
  if (!usage) return null;
  const bucket = usage.summary[activePeriod] || usage.summary.today;

  const periods: { id: UsagePeriod; label: string }[] = [
    { id: "today", label: "Today" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
    { id: "all_time", label: "All" },
  ];

  return (
    <div className="px-4 py-3 border-b border-line shrink-0 bg-surface">
      {/* Header with History Button */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Coins size={13} className="text-accent" />
          <span className="text-[11px] font-semibold tracking-wide text-fg-2 uppercase">Usage & Cost</span>
        </div>
        <button
          type="button"
          onClick={onOpenHistory}
          title="Lihat riwayat lengkap"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 transition-colors cursor-pointer"
        >
          <BarChart2 size={12} />
          <span>History</span>
        </button>
      </div>

      {/* Interval Selector Tabs */}
      <div className="grid grid-cols-4 gap-1 p-0.5 bg-surface-2 rounded-lg mb-2">
        {periods.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChangePeriod(p.id)}
            className={`py-1 text-[10px] font-medium rounded transition-all text-center cursor-pointer ${
              activePeriod === p.id
                ? "bg-surface text-fg font-semibold shadow-xs"
                : "text-muted hover:text-fg-2"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Main Metrics */}
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-[10px] text-muted block leading-none mb-1">Est. Price</span>
          <span className="text-base font-bold font-mono text-accent">
            {formatCost(bucket.cost_usd)}
          </span>
        </div>
        <div className="text-right">
          <span className="text-[10px] text-muted block leading-none mb-1">Total Tokens</span>
          <span className="text-xs font-semibold font-mono text-fg">
            {formatTokens(bucket.total_tokens)}
          </span>
        </div>
      </div>

      {/* Breakdown Details */}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted font-mono pt-1.5 border-t border-line/40">
        <span>↑{formatTokens(bucket.input_tokens)}</span>
        <span className="opacity-30">·</span>
        <span>↓{formatTokens(bucket.output_tokens)}</span>
        <span className="opacity-30">·</span>
        <span>cache {formatTokens(bucket.cache_read_tokens)}</span>
      </div>
    </div>
  );
}

export function mergeUsage(c: UsageResponse | null, r: UsageResponse | null): UsageResponse | null {
  if (!c && !r) return null;
  if (!c) return r;
  if (!r) return c;

  const mergeBucket = (b1: UsageBucket, b2?: UsageBucket): UsageBucket => ({
    sessions: (b1?.sessions || 0) + (b2?.sessions || 0),
    input_tokens: (b1?.input_tokens || 0) + (b2?.input_tokens || 0),
    output_tokens: (b1?.output_tokens || 0) + (b2?.output_tokens || 0),
    cache_read_tokens: (b1?.cache_read_tokens || 0) + (b2?.cache_read_tokens || 0),
    cache_creation_tokens: (b1?.cache_creation_tokens || 0) + (b2?.cache_creation_tokens || 0),
    total_tokens: (b1?.total_tokens || 0) + (b2?.total_tokens || 0),
    cost_usd: Number(((b1?.cost_usd || 0) + (b2?.cost_usd || 0)).toFixed(4)),
  });

  const mergedSummary = {
    today: mergeBucket(c.summary.today, r.summary.today),
    week: mergeBucket(c.summary.week, r.summary.week),
    month: mergeBucket(c.summary.month, r.summary.month),
    all_time: mergeBucket(c.summary.all_time, r.summary.all_time),
  };

  const histMap = new Map<string, UsageHistoryItem>();
  for (const h of c.history) histMap.set(h.date, { ...h });
  for (const h of r.history) {
    const existing = histMap.get(h.date);
    if (existing) {
      existing.sessions += h.sessions;
      existing.input_tokens += h.input_tokens;
      existing.output_tokens += h.output_tokens;
      existing.total_tokens += h.total_tokens;
      existing.cost_usd = Number((existing.cost_usd + h.cost_usd).toFixed(4));
    } else {
      histMap.set(h.date, { ...h });
    }
  }
  const mergedHistory = Array.from(histMap.values()).sort((a, b) => b.date.localeCompare(a.date));

  const mergedModels: Record<string, { cost_usd: number; input_tokens: number; output_tokens: number }> = {
    ...c.models,
  };
  for (const [m, info] of Object.entries(r.models)) {
    if (mergedModels[m]) {
      mergedModels[m] = {
        cost_usd: Number((mergedModels[m].cost_usd + info.cost_usd).toFixed(4)),
        input_tokens: mergedModels[m].input_tokens + info.input_tokens,
        output_tokens: mergedModels[m].output_tokens + info.output_tokens,
      };
    } else {
      mergedModels[m] = info;
    }
  }

  return {
    summary: mergedSummary,
    history: mergedHistory,
    models: mergedModels,
  };
}

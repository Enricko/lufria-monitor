import { Activity } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usePoll } from "../api";
import { TimeChart } from "../components/charts";
import { Swatch } from "../components/ui";
import { AXIS_TEXT, GRID, NEUTRAL, SLOT } from "../palette";
import { formatAgo, formatCost, formatTokens } from "./format";

export type AnalyticsRange = "today" | "24h" | "7d" | "30d" | "60d" | "all";
const RANGES: { id: AnalyticsRange; label: string }[] = [
  { id: "today", label: "Today" }, { id: "24h", label: "24h" }, { id: "7d", label: "7D" },
  { id: "30d", label: "30D" }, { id: "60d", label: "60D" }, { id: "all", label: "All" },
];

interface Counts {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tokens: number;
  cost_usd: number;
}
export interface Analytics {
  generated_at: number;
  range: AnalyticsRange;
  timezone: string;
  step_seconds: number;
  unpriced: boolean;
  totals: Counts & { sessions: number };
  series: (Counts & { t: number })[];
  by_family: (Counts & { family: string })[];
  by_model: (Counts & { model: string; family: string; last_used: number })[];
  recent: { ts: number; model: string; session: string; input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_write_tokens: number; cost_usd: number | null }[];
  live_models: string[];
}

type Metric = "tokens" | "requests" | "cost_usd";
const METRICS: { id: Metric; label: string; color: string; format: (v: number) => string }[] = [
  { id: "tokens", label: "Tokens", color: SLOT.blue, format: (v) => formatTokens(v) },
  { id: "requests", label: "Requests", color: SLOT.aqua, format: (v) => Math.round(v).toLocaleString() },
  { id: "cost_usd", label: "Cost", color: SLOT.yellow, format: (v) => formatCost(v) },
];

/** A family keeps its hue on every chart, table and panel. */
const FAMILY_COLOR: Record<string, string> = { Opus: SLOT.blue, Sonnet: SLOT.orange, Haiku: SLOT.aqua, Fable: SLOT.magenta };
export const familyColor = (family: string) => FAMILY_COLOR[family] ?? NEUTRAL;
export function familyOf(model: string): string {
  const low = model.toLowerCase();
  for (const name of ["opus", "sonnet", "haiku", "fable"]) if (low.includes(name)) return name[0].toUpperCase() + name.slice(1);
  return model.includes("/") ? model.split("/")[0] : "Other";
}

const totalInput = (c: Pick<Counts, "input_tokens" | "cache_read_tokens" | "cache_write_tokens">) => c.input_tokens + c.cache_read_tokens + c.cache_write_tokens;
const tick = { fill: AXIS_TEXT, fontSize: 11, fontFamily: "Fira Code, monospace" };

function Segmented<T extends string>({ items, value, onChange, label }: {
  items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {items.map((i) => (
        <button key={i.id} type="button" aria-pressed={value === i.id} onClick={() => onChange(i.id)}
          className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            value === i.id ? "bg-bg text-fg shadow-xs" : "text-muted hover:text-fg-2"}`}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

function Panel({ title, actions, children, className = "" }: { title: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-surface-2/30 p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-3.5 text-center">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums text-fg">{value}</div>
      {note && <div className="mt-0.5 text-[10px] text-muted">{note}</div>}
    </div>
  );
}

function BarTip({ active, payload, format }: { active?: boolean; payload?: readonly { payload?: { name: string; value: number; color: string } }[]; format: (v: number) => string }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <div className="flex items-center gap-1.5 text-muted"><Swatch color={row.color} />{row.name}</div>
      <div className="mt-0.5 font-mono text-fg">{format(row.value)}</div>
    </div>
  );
}

function Bars({ rows, format, horizontal }: { rows: { name: string; value: number; color: string }[]; format: (v: number) => string; horizontal?: boolean }) {
  if (!rows.length) return <p className="py-10 text-center text-xs text-muted">No requests in this range.</p>;
  const height = horizontal ? Math.max(120, rows.length * 38 + 24) : 200;
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          {horizontal ? (
            <>
              <XAxis type="number" tickFormatter={format} tick={tick} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis type="category" dataKey="name" tick={tick} width={132} tickLine={false} axisLine={false} interval={0} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" tick={tick} tickLine={false} axisLine={{ stroke: GRID }} interval={0} />
              <YAxis tickFormatter={format} tick={tick} width={56} tickLine={false} axisLine={false} />
            </>
          )}
          <Tooltip cursor={{ fill: GRID, opacity: 0.5 }} isAnimationActive={false}
            content={(p) => <BarTip active={p.active} payload={p.payload} format={format} />} />
          <Bar dataKey="value" maxBarSize={horizontal ? 18 : 40} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.name} fill={r.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function axisLabel(step: number, tz: string): (t: number) => string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short" });
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (step >= 86400) return (t) => day.format(t * 1000);
  if (step > 3600) return (t) => `${day.format(t * 1000)} ${hour.format(t * 1000)}`;
  return (t) => hour.format(t * 1000);
}

/** The Overview tab: totals, a chart over time, per family and per model, recent requests. Refreshes on its own. */
export function AnalyticsOverview() {
  const [range, setRange] = useState<AnalyticsRange>("today");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [barMetric, setBarMetric] = useState<Metric>("tokens");
  const { data, error } = usePoll<Analytics>(`/api/claude/analytics?range=${range}`, 3000);
  const stale = data?.range !== range;

  const m = METRICS.find((x) => x.id === metric)!;
  const bm = METRICS.find((x) => x.id === barMetric)!;
  const xTick = useMemo(() => (data ? axisLabel(data.step_seconds, data.timezone) : (t: number) => String(t)), [data]);
  const chart = useMemo(() => (data?.series ?? []).map((s) => ({ ts: s.t, v: s[metric] })), [data, metric]);

  if (!data) return <p className="py-16 text-center text-sm text-muted">{error ? `Could not load usage: ${error}` : "Loading usage…"}</p>;
  const t = data.totals;
  const families = data.by_family.map((f) => ({ name: f.family, value: f[barMetric], color: familyColor(f.family) }));
  const models = data.by_model.slice(0, 8).map((x) => ({ name: x.model, value: x[barMetric], color: familyColor(x.family) }));
  const barTitle = bm.label.toLowerCase();

  return (
    <div className={`space-y-4 transition-opacity ${stale ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented items={RANGES} value={range} onChange={setRange} label="Time range" />
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted" title="Refreshes every 3 seconds">
          <Activity size={12} className="text-accent" aria-hidden />
          Live · {t.sessions} {t.sessions === 1 ? "session" : "sessions"}
          {data.live_models.length > 0 && <span className="text-fg-2"> · in use: {data.live_models.join(", ")}</span>}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Total requests" value={t.requests.toLocaleString()} />
        <Tile label="Total input" value={formatTokens(totalInput(t))} note={`${formatTokens(t.input_tokens)} uncached`} />
        <Tile label="Cached tokens" value={formatTokens(t.cache_read_tokens)} note={`${formatTokens(t.cache_write_tokens)} written`} />
        <Tile label="Output tokens" value={formatTokens(t.output_tokens)} />
        <Tile label="Est. cost" value={`~${formatCost(t.cost_usd)}`} note={data.unpriced ? "some models unpriced" : "API-equivalent price"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={`${m.label} over time`} className="lg:col-span-2"
          actions={<Segmented items={METRICS} value={metric} onChange={setMetric} label="Chart metric" />}>
          <TimeChart data={chart} series={[{ key: "v", label: m.label, color: m.color }]} format={m.format} xTick={xTick} height={240} />
        </Panel>
        <Panel title="Recent requests">
          {data.recent.length === 0 ? <p className="py-10 text-center text-xs text-muted">No requests yet.</p> : (
            <ul className="space-y-1.5 font-mono text-[11px]">
              {data.recent.map((r, i) => (
                <li key={`${r.ts}-${i}`} className="flex items-center gap-2" title={`${r.model} · ${r.session}`}>
                  <Swatch color={familyColor(familyOf(r.model))} />
                  <span className="min-w-0 flex-1 truncate text-fg-2">{r.model}</span>
                  <span className="shrink-0 tabular-nums text-muted">↑{formatTokens(totalInput(r))} ↓{formatTokens(r.output_tokens)}</span>
                  <span className="w-14 shrink-0 text-right text-muted">{formatAgo(r.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="By model family" actions={<Segmented items={METRICS} value={barMetric} onChange={setBarMetric} label="Family metric" />}>
          <Bars rows={families} format={bm.format} />
        </Panel>
        <Panel title={`Top models by ${barTitle}`}>
          <Bars rows={models} format={bm.format} horizontal />
        </Panel>
      </div>

      <Panel title="Usage by model">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="py-2 pr-3 font-semibold">Model</th>
                <th className="px-3 py-2 text-right font-semibold">Requests</th>
                <th className="px-3 py-2 text-right font-semibold">Last used</th>
                <th className="px-3 py-2 text-right font-semibold">Input</th>
                <th className="px-3 py-2 text-right font-semibold">Cached</th>
                <th className="px-3 py-2 text-right font-semibold">Output</th>
                <th className="py-2 pl-3 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60 font-mono tabular-nums">
              {data.by_model.map((x) => (
                <tr key={x.model} className="hover:bg-surface-2/40">
                  <td className="py-2 pr-3 font-sans"><span className="flex items-center gap-2 text-fg"><Swatch color={familyColor(x.family)} />{x.model}</span></td>
                  <td className="px-3 py-2 text-right text-fg-2">{x.requests.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-muted">{formatAgo(x.last_used)}</td>
                  <td className="px-3 py-2 text-right text-muted">{formatTokens(x.input_tokens + x.cache_write_tokens)}</td>
                  <td className="px-3 py-2 text-right text-muted">{formatTokens(x.cache_read_tokens)}</td>
                  <td className="px-3 py-2 text-right text-muted">{formatTokens(x.output_tokens)}</td>
                  <td className="py-2 pl-3 text-right font-semibold text-fg">{formatCost(x.cost_usd)}</td>
                </tr>
              ))}
              {data.by_model.length === 0 && <tr><td colSpan={7} className="py-6 text-center font-sans text-muted">No requests in this range.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-muted">
          Cost is the API-equivalent price from Claude Code's own per-model totals, split across requests by token weight. A subscription isn't billed per token.
        </p>
      </Panel>
    </div>
  );
}

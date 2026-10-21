import { Pause, Play } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { dateTime, time } from "../format";
import { AXIS_TEXT, GRID, NEUTRAL, SURFACE } from "../palette";
import { Legend, Swatch } from "./ui";

export type Series = { key: string; label: string; color: string };

const tick = { fill: AXIS_TEXT, fontSize: 11, fontFamily: "Fira Code, monospace" };

type TipEntry = { dataKey?: unknown; name?: unknown; value?: unknown; color?: string };

function ChartTip({ active, payload, label, format, labelFormat }: {
  active?: boolean;
  payload?: readonly TipEntry[];
  label?: unknown;
  format: (v: number) => string;
  labelFormat: (l: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line-strong bg-surface-2/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <div className="mb-1 text-muted">{labelFormat(label as number | string)}</div>
      {[...payload].reverse().map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-fg-2">
            <Swatch color={p.color ?? NEUTRAL} />
            {String(p.name)}
          </span>
          <span className="tnum font-mono text-fg">{p.value == null ? "–" : format(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

/** Time-series area chart (history or live). One y-axis, 2px lines, 10% wash. */
export const TimeChart = memo(function TimeChart({ data, series, format, axisFormat, height = 220, max, stacked, longRange, live }: {
  data: Record<string, number | null>[];
  series: Series[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
  max?: number;
  stacked?: boolean;
  longRange?: boolean;
  live?: boolean;
}) {
  const xFormat = (t: number) =>
    live
      ? new Date(t * 1000).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : longRange ? dateTime(t) : time(t);
  return (
    <div>
      {series.length > 1 && (
        <div className="mb-3">
          <Legend items={series.map((s) => ({ label: s.label, color: s.color, line: !stacked }))} />
        </div>
      )}
      <div style={{ height }}>
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 28, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="ts" tickFormatter={xFormat} tick={tick} minTickGap={48} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tickFormatter={axisFormat ?? format} tick={tick} width={76} domain={[0, max ?? "auto"]} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ stroke: "#334155", strokeWidth: 1 }}
              isAnimationActive={false}
              content={(p) => <ChartTip active={p.active} payload={p.payload} label={p.label} format={format} labelFormat={(l) => xFormat(Number(l))} />}
            />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stackId={stacked ? "a" : undefined}
                stroke={s.color}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={stacked ? 0.35 : 0.1}
                connectNulls
                dot={false}
                activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});

/** Live streaming chart with the pause control a moving chart needs. */
export function StreamChart(props: Omit<Parameters<typeof TimeChart>[0], "live"> & { title?: ReactNode }) {
  const [frozen, setFrozen] = useState<typeof props.data | null>(null);
  return (
    <div>
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          onClick={() => setFrozen(frozen ? null : props.data)}
          aria-pressed={!!frozen}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
        >
          {frozen ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
          {frozen ? "Resume" : "Pause"}
        </button>
      </div>
      <TimeChart {...props} data={frozen ?? props.data} live />
    </div>
  );
}

/** Stacked columns: rounded 4px data-end on the top segment only, 2px surface gap between segments. */
export function StackedColumns({ data, series, xKey, xFormat, format, tooltipLabel, height = 260 }: {
  data: Record<string, number | string | null>[];
  series: Series[];
  xKey: string;
  xFormat: (v: string) => string;
  format: (v: number) => string;
  tooltipLabel?: (v: string) => string;
  height?: number;
}) {
  // which series is the top non-zero segment of each column
  const rows = data.map((d) => {
    let top: string | null = null;
    for (const s of series) if (Number(d[s.key]) > 0) top = s.key;
    return { ...d, _top: top };
  });
  return (
    <div>
      <div className="mb-3">
        <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey={xKey} tickFormatter={xFormat} tick={tick} minTickGap={16} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tickFormatter={format} tick={tick} width={72} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "#1e293b", fillOpacity: 0.5 }}
              isAnimationActive={false}
              content={(p) => <ChartTip active={p.active} payload={p.payload} label={p.label} format={format} labelFormat={(l) => (tooltipLabel ?? xFormat)(String(l))} />}
            />
            {series.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="a"
                fill={s.color}
                maxBarSize={24}
                isAnimationActive={false}
                shape={(p: unknown) => <Segment {...(p as SegmentProps)} seriesKey={s.key} />}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type SegmentProps = { x: number; y: number; width: number; height: number; fill: string; payload: { _top: string | null } };

function Segment({ x, y, width, height, fill, payload, seriesKey }: SegmentProps & { seriesKey: string }) {
  if (!height || height <= 0) return null;
  const isTop = payload._top === seriesKey;
  // 2px surface gap carved off the top of every segment below the top one
  const h = Math.max(height - (isTop ? 0 : 2), 0);
  const top = isTop ? y : y + 2;
  if (h <= 0) return null;
  if (!isTop) return <rect x={x} y={top} width={width} height={h} fill={fill} />;
  const r = Math.min(4, width / 2, h);
  return (
    <path
      d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${top + h} Z`}
      fill={fill}
    />
  );
}

/** Tiny trend line for stat tiles: de-emphasis hue, current value as an end dot. */
export const Sparkline = memo(function Sparkline({ values, color, max }: { values: number[]; color: string; max?: number }) {
  const data = values.map((v, i) => ({ i, v }));
  return (
    <div className="mt-3 h-10" aria-hidden>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 1, left: 0 }}>
          <YAxis hide domain={[0, max ?? "auto"]} />
          <Area
            type="monotone"
            dataKey="v"
            stroke="#64748b"
            strokeWidth={1.5}
            fill="#64748b"
            fillOpacity={0.08}
            isAnimationActive={false}
            dot={(p: { index?: number; cx?: number; cy?: number }) =>
              p.index === data.length - 1 && p.cx != null && p.cy != null ? (
                <circle key="end" cx={p.cx} cy={p.cy} r={3.5} fill={color} stroke={SURFACE} strokeWidth={2} />
              ) : (
                <g key={p.index} />
              )
            }
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

/** Horizontal bars in plain HTML: label left, thin bar, value at the tip. */
export function HBars({ rows, color, format, sub }: {
  rows: { label: string; value: number; title?: string }[];
  color: string;
  format: (v: number) => string;
  sub?: (i: number) => ReactNode;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.label} title={r.title ?? r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-fg-2">{r.label}</span>
            <span className="tnum shrink-0 font-mono text-[13px] text-fg">
              {format(r.value)}
              {sub && <span className="ml-2 text-muted">{sub(i)}</span>}
            </span>
          </div>
          <div className="h-1.5 rounded-r-full" style={{ width: `${Math.max((r.value / max) * 100, 0.5)}%`, background: color }} />
        </li>
      ))}
    </ul>
  );
}

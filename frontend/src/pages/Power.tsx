import { AppWindow, BarChart3, Info, LineChart, Table2, Wallet, Zap } from "lucide-react";
import { useState } from "react";
import { usePoll, type Live } from "../api";
import { HBars, StackedColumns, TimeChart } from "../components/charts";
import { PowerBreakdown } from "../components/PowerBreakdown";
import { Card, Empty, PageHeader, Segmented, Skeleton, Status, Swatch } from "../components/ui";
import { dateTime, kwh, rupiah, rupiahFine, rupiahShort, watts } from "../format";
import { COMPONENTS, NEUTRAL, SLOT } from "../palette";
import { isLong, RANGES, type HistoryRow, type Range } from "../ranges";

type Totals = { kwh: number; cost: number; avg_w: number | null; hours: number };
type Summary = {
  totals: Record<"this_hour" | "today" | "this_week" | "this_month" | "all_time", Totals>;
  projection: { avg_w: number; kwh_day: number; kwh_month: number; kwh_year: number; cost_day: number; cost_month: number; cost_year: number } | null;
  rate: number;
  tariff_rp_per_kwh: number;
  ppj_percent: number;
  timezone: string;
};
type Bucket = {
  bucket: string;
  start: number;
  kwh: number;
  cost: number;
  avg_w: number | null;
  max_w: number | null;
  coverage_hours: number;
  components: Record<string, number>;
};
type AppsData = {
  available: boolean;
  updated: number | null;
  total_kwh: number;
  total_cost: number;
  other_kwh: number;
  apps: { name: string; kwh: number; cost: number; share: number; cpu: number | null }[];
};
type Period = "hour" | "day" | "week" | "month";
type Window = "1h" | "24h" | "7d" | "30d";

const PERIODS: { value: Period; label: string }[] = [
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];
const PERIOD_HOURS: Record<Period, number> = { hour: 1, day: 24, week: 168, month: 720 };
const WINDOWS: { value: Window; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const ENERGY_SERIES = [
  ...COMPONENTS.map((c) => ({ key: c.key, label: c.label, color: c.color })),
  { key: "other", label: "Unsplit (before WattSeal)", color: NEUTRAL },
];

function bucketLabel(b: string, period: Period) {
  if (period === "hour") return b.slice(11, 16);
  if (period === "day") return new Date(`${b}T00:00:00`).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
  if (period === "month") return new Date(`${b}-01T00:00:00`).toLocaleDateString("id-ID", { month: "short", year: "2-digit" });
  return b.replace("-W", " W");
}

export function Power({ live }: { live: Live | null; history: Live[] }) {
  const { data: sum } = usePoll<Summary>("/api/power/summary", 30000);
  const [period, setPeriod] = useState<Period>("hour");
  const [metric, setMetric] = useState<"cost" | "kwh">("cost");
  const [showTable, setShowTable] = useState(false);
  const { data: buckets } = usePoll<Bucket[]>(`/api/power/buckets?period=${period}`, 60000);
  const [win, setWin] = useState<Window>("24h");
  const { data: apps } = usePoll<AppsData>(`/api/power/apps?window=${win}`, 60000);
  const [range, setRange] = useState<Range>("24h");
  const { data: hist } = usePoll<HistoryRow[]>(`/api/history?range=${range}`, 60000);

  const p = live?.power;
  const rate = sum?.rate ?? 0;
  const ws = p?.wattseal;

  const energyRows = (buckets ?? []).map((b) => {
    const row: Record<string, number | string | null> = { bucket: b.bucket };
    for (const s of ENERGY_SERIES) {
      const v = b.components[s.key] ?? 0;
      row[s.key] = metric === "cost" ? v * rate : v;
    }
    return row;
  });
  const usedSeries = ENERGY_SERIES.filter((s) => (buckets ?? []).some((b) => (b.components[s.key] ?? 0) > 0));

  return (
    <>
      <PageHeader
        title="Power"
        description={sum ? `Energy and cost at ${rupiahFine(sum.rate)}/kWh (PLN${sum.ppj_percent ? ` + PPJ ${sum.ppj_percent}%` : ""}) · ${sum.timezone}` : "Loading…"}
        actions={
          p?.source === "wattseal" ? <Status state="good">WattSeal live</Status>
            : p?.source === "rapl" ? <Status state="warn">WattSeal offline · RAPL only</Status>
            : p ? <Status state="bad">No power data</Status> : null
        }
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Live draw" icon={Zap}>
          {p?.total != null ? (
            <>
              <div className="flex items-baseline gap-2">
                <span className="text-6xl font-semibold tracking-tight">{p.total.toFixed(1)}</span>
                <span className="text-xl text-muted">W</span>
              </div>
              <p className="mt-1 text-sm text-muted">
                ≈ {rupiahFine((p.total / 1000) * rate)} per hour · {rupiah((p.total / 1000) * 24 * 30 * rate)} per month at this rate
              </p>
              <div className="mt-5">
                <PowerBreakdown power={p} />
              </div>
            </>
          ) : <Skeleton className="h-72" />}
        </Card>

        <Card title="Usage & cost" icon={Wallet} className="xl:col-span-2">
          {sum ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <CostTile label="This hour" t={sum.totals.this_hour} fine />
                <CostTile label="Today" t={sum.totals.today} />
                <CostTile label="This week" t={sum.totals.this_week} />
                <CostTile label="This month" t={sum.totals.this_month} />
              </div>
              <div className="mt-5 border-t border-line pt-5">
                <div className="mb-3 text-xs text-muted">
                  Projection from the last 24h average ({watts(sum.projection?.avg_w)})
                </div>
                {sum.projection ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Projection label="Per day" cost={sum.projection.cost_day} energy={sum.projection.kwh_day} />
                    <Projection label="Per month" cost={sum.projection.cost_month} energy={sum.projection.kwh_month} highlight />
                    <Projection label="Per year" cost={sum.projection.cost_year} energy={sum.projection.kwh_year} />
                  </div>
                ) : <p className="text-sm text-muted">Collecting data…</p>}
              </div>
              <p className="mt-4 text-xs text-muted">
                All time: {kwh(sum.totals.all_time.kwh)} · {rupiah(sum.totals.all_time.cost)} over {sum.totals.all_time.hours.toFixed(1)} h recorded
              </p>
            </>
          ) : <Skeleton className="h-72" />}
        </Card>
      </div>

      <Card
        title="Energy by component"
        icon={BarChart3}
        className="mt-4"
        actions={
          <div className="flex flex-wrap gap-2">
            <Segmented label="Unit" value={metric} onChange={setMetric} options={[{ value: "cost", label: "Rupiah" }, { value: "kwh", label: "kWh" }]} />
            <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS} />
          </div>
        }
      >
        {buckets == null ? <Skeleton className="h-[300px]" /> : buckets.length === 0 ? (
          <Empty icon={BarChart3}>No energy recorded yet. The first bar appears after a minute.</Empty>
        ) : (
          <>
            <StackedColumns
              data={energyRows}
              series={usedSeries}
              xKey="bucket"
              xFormat={(b) => bucketLabel(b, period)}
              tooltipLabel={(b) => b}
              format={(v) => (metric === "cost" ? rupiahShort(v) : v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} Wh` : `${v.toFixed(2)} kWh`)}
            />
            <button
              type="button"
              onClick={() => setShowTable(!showTable)}
              aria-expanded={showTable}
              className="mt-4 inline-flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
            >
              <Table2 size={14} aria-hidden />
              {showTable ? "Hide table" : "Show as table"}
            </button>
            {showTable && (
              <div className="mt-2 max-h-96 overflow-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Period</th>
                      <th className="px-3 py-2 text-right font-medium">Energy</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                      <th className="px-3 py-2 text-right font-medium">Average</th>
                      <th className="px-3 py-2 text-right font-medium">Peak</th>
                      <th className="px-3 py-2 text-right font-medium">Recorded</th>
                    </tr>
                  </thead>
                  <tbody className="tnum font-mono text-[13px]">
                    {[...buckets].reverse().map((b) => (
                      <tr key={b.bucket} className="border-t border-line">
                        <td className="px-3 py-2">{b.bucket}</td>
                        <td className="px-3 py-2 text-right">{kwh(b.kwh)}</td>
                        <td className="px-3 py-2 text-right">{rupiahFine(b.cost)}</td>
                        <td className="px-3 py-2 text-right">{watts(b.avg_w)}</td>
                        <td className="px-3 py-2 text-right">{watts(b.max_w)}</td>
                        <td className="px-3 py-2 text-right text-muted">
                          {Math.min(100, (b.coverage_hours / PERIOD_HOURS[period]) * 100).toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Apps right now" icon={AppWindow}>
          {p?.apps.length ? (
            <HBars
              rows={p.apps.slice(0, 8).map((a) => ({ label: a.name, value: a.w }))}
              color={SLOT.blue}
              format={(v) => watts(v, 2)}
              sub={(i) => `${(p.apps[i].cpu ?? 0).toFixed(1)}% CPU`}
            />
          ) : p?.source === "wattseal" ? <Skeleton className="h-64" /> : (
            <Empty icon={AppWindow}>Per-app power needs WattSeal running.</Empty>
          )}
          <p className="mt-4 flex gap-2 text-xs text-muted">
            <Info size={14} className="mt-px shrink-0" aria-hidden />
            WattSeal splits measured power between apps by their share of CPU time, so on an idle server the
            few active apps also carry the idle draw.
          </p>
        </Card>

        <Card title="Energy by app" icon={AppWindow}
          actions={<Segmented label="Window" value={win} onChange={setWin} options={WINDOWS} />}>
          {!apps ? <Skeleton className="h-64" /> : !apps.available || apps.apps.length === 0 ? (
            <Empty icon={AppWindow}>No per-app data yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="pb-2 font-medium">App</th>
                    <th className="hidden pb-2 font-medium sm:table-cell">Share</th>
                    <th className="pb-2 text-right font-medium">Energy</th>
                    <th className="pb-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.apps.slice(0, 10).map((a) => (
                    <tr key={a.name} className="border-t border-line">
                      <td className="max-w-40 py-2 pr-3" title={a.name}>
                        <div className="truncate text-fg-2">{a.name}</div>
                        <div className="tnum font-mono text-[11px] text-muted sm:hidden">{(a.share * 100).toFixed(0)}% of energy</div>
                      </td>
                      <td className="hidden w-1/3 py-2 pr-3 sm:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-surface-2">
                            <div className="h-full rounded-r-full" style={{ width: `${Math.max(a.share * 100, 0.5)}%`, background: SLOT.blue }} />
                          </div>
                          <span className="tnum w-10 text-right font-mono text-xs text-muted">{(a.share * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="tnum whitespace-nowrap py-2 text-right font-mono text-[13px]">{kwh(a.kwh)}</td>
                      <td className="tnum whitespace-nowrap py-2 pl-3 text-right font-mono text-[13px]">{rupiahFine(a.cost)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line text-muted">
                    <td className="py-2 sm:hidden">Other apps</td>
                    <td className="hidden py-2 sm:table-cell" colSpan={2}>Other apps</td>
                    <td className="tnum whitespace-nowrap py-2 text-right font-mono text-[13px]">{kwh(apps.other_kwh)}</td>
                    <td className="tnum whitespace-nowrap py-2 pl-3 text-right font-mono text-[13px]">{rupiahFine(apps.other_kwh * rate)}</td>
                  </tr>
                  <tr className="border-t border-line-strong font-medium">
                    <td className="py-2 sm:hidden">Total (excl. platform)</td>
                    <td className="hidden py-2 sm:table-cell" colSpan={2}>Total (excl. platform)</td>
                    <td className="tnum whitespace-nowrap py-2 text-right font-mono text-[13px]">{kwh(apps.total_kwh)}</td>
                    <td className="tnum whitespace-nowrap py-2 pl-3 text-right font-mono text-[13px]">{rupiahFine(apps.total_cost)}</td>
                  </tr>
                </tbody>
              </table>
              {apps.updated && <p className="mt-3 text-xs text-muted">Updated {dateTime(apps.updated)} · refreshes every 2 minutes</p>}
            </div>
          )}
        </Card>
      </div>

      <Card title="Power over time" icon={LineChart} className="mt-4"
        actions={<Segmented label="Range" value={range} options={RANGES} onChange={setRange} />}>
        {hist == null ? <Skeleton className="h-[300px]" /> : hist.length === 0 ? (
          <Empty icon={LineChart}>No history yet. Samples are saved once per minute.</Empty>
        ) : (
          <TimeChart
            data={hist}
            stacked
            height={260}
            longRange={isLong(range)}
            format={(v) => `${v.toFixed(0)} W`}
            series={COMPONENTS.filter((c) => hist.some((h) => (h[`p_${c.key}`] ?? 0) > 0))
              .map((c) => ({ key: `p_${c.key}`, label: c.label, color: c.color }))}
          />
        )}
      </Card>

      <Card title="How this is measured" icon={Info} className="mt-4">
        <ul className="grid gap-3 text-sm text-fg-2 md:grid-cols-2">
          <Method color={COMPONENTS[0].color} name="CPU" text="Intel RAPL package energy, read by WattSeal every second. Includes the integrated GPU." />
          <Method color={COMPONENTS[1].color} name="Memory" text="WattSeal's model: a flat 5 W." />
          <Method color={COMPONENTS[2].color} name="Storage" text="WattSeal's model per physical disk: HDD 3 W idle + 0.035 W per MiB/s, NVMe 0.05 W + 0.015, USB 0.3 W + 0.02." />
          <Method color={COMPONENTS[3].color} name="Network" text="WattSeal's model per physical NIC: 0.2 W + 0.01 W per MiB/s, capped at 3 W." />
          <Method color={COMPONENTS[4].color} name="GPU" text="NVIDIA dGPU power from the driver, read only while the GPU is awake. When it sleeps (D3cold) it counts as 0 W. An Intel iGPU is inside the CPU figure." />
          <Method color={COMPONENTS[5].color} name="Platform" text="Your setting for what nothing measures: motherboard, fans, Wi-Fi, adapter loss. Change it in Settings." />
          <Method color={NEUTRAL} name="Correction" text={
            ws?.raw_total != null
              ? `WattSeal alone reports ${watts(ws.raw_total)}: it counts every mount and virtual interface as a device (disk ${watts(ws.raw_disk)}, network ${watts(ws.raw_net)}). Only physical devices are counted here, and app power is scaled to match.`
              : "WattSeal's disk and network figures are recomputed for physical devices only."
          } />
        </ul>
      </Card>
    </>
  );
}

function CostTile({ label, t, fine }: { label: string; t?: Totals; fine?: boolean }) {
  return (
    <div className="rounded-xl bg-bg p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tracking-tight">{fine ? rupiahFine(t?.cost) : rupiah(t?.cost)}</div>
      <div className="tnum mt-0.5 font-mono text-xs text-muted">{t ? `${kwh(t.kwh)} · avg ${watts(t.avg_w, 0)}` : "–"}</div>
    </div>
  );
}

function Projection({ label, cost, energy, highlight }: { label: string; cost: number; energy: number; highlight?: boolean }) {
  return (
    <div className={`rounded-xl p-4 ${highlight ? "border border-accent/40 bg-accent/5" : "bg-bg"}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold tracking-tight">{rupiah(cost)}</div>
      <div className="tnum font-mono text-xs text-muted">{energy.toFixed(energy < 10 ? 2 : 0)} kWh</div>
    </div>
  );
}

function Method({ color, name, text }: { color: string; name: string; text: string }) {
  return (
    <li className="flex gap-3 rounded-xl bg-bg p-3">
      <span className="mt-1.5"><Swatch color={color} /></span>
      <div>
        <div className="font-medium text-fg">{name}</div>
        <div className="mt-0.5 text-muted">{text}</div>
      </div>
    </li>
  );
}

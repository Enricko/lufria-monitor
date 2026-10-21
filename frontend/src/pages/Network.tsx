import { ArrowDown, ArrowUp, Gauge, Globe, History, Loader2, Play, Router } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, usePoll, type Live } from "../api";
import { Sparkline, TimeChart } from "../components/charts";
import { Button, Card, Empty, Kpi, Legend, PageHeader, Segmented, Skeleton, Status, Tag } from "../components/ui";
import { bits, bitsAxis, dateTime } from "../format";
import { AXIS_TEXT, GRID, SLOT } from "../palette";
import { isLong, RANGES, type HistoryRow, type Range } from "../ranges";

type SpeedTest = {
  ts: number;
  down_mbps: number | null;
  up_mbps: number | null;
  ping_ms: number | null;
  jitter_ms: number | null;
  loss: number | null;
  server: string | null;
  isp: string | null;
  url: string | null;
  error: string | null;
};

const VIRTUAL = /^(lo|docker|br-|veth|virbr|tun|tap|wg)/;
const tick = { fill: AXIS_TEXT, fontSize: 11, fontFamily: "Fira Code, monospace" };

export function Network({ live, history }: { live: Live | null; history: Live[] }) {
  const [range, setRange] = useState<Range>("24h");
  const { data: hist } = usePoll<HistoryRow[]>(`/api/history?range=${range}`, 60000);
  const { data: st, reload } = usePoll<{ running: boolean; history: SpeedTest[] }>("/api/speedtest", 5000);
  const [starting, setStarting] = useState(false);

  const tests = st?.history ?? [];
  const ok = tests.filter((t) => !t.error);
  const last = tests[tests.length - 1];
  const running = starting || !!st?.running;
  const last60 = history.slice(-60);

  const runTest = async () => {
    setStarting(true);
    try {
      await api("/api/speedtest", { method: "POST" });
    } finally {
      setStarting(false);
      reload();
    }
  };

  const nics = live ? Object.entries(live.net.per_nic).sort(([a], [b]) => Number(VIRTUAL.test(a)) - Number(VIRTUAL.test(b)) || a.localeCompare(b)) : [];

  return (
    <>
      <PageHeader title="Network" description="Live traffic, internet speed and history" />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Live traffic" icon={Router}>
          <div className="grid grid-cols-2 gap-4">
            <Kpi label="Download" value={bits(live?.net.rx)} sub={<span className="inline-flex items-center gap-1"><ArrowDown size={12} aria-hidden />physical + virtual</span>} />
            <Kpi label="Upload" value={bits(live?.net.tx)} sub={<span className="inline-flex items-center gap-1"><ArrowUp size={12} aria-hidden />physical + virtual</span>} />
          </div>
          <Sparkline values={last60.map((h) => h.net.rx + h.net.tx)} color={SLOT.blue} />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Interface</th>
                  <th className="pb-2 text-right font-medium">Down</th>
                  <th className="pb-2 text-right font-medium">Up</th>
                </tr>
              </thead>
              <tbody className="tnum font-mono text-[13px]">
                {nics.map(([nic, v]) => (
                  <tr key={nic} className={`border-t border-line ${VIRTUAL.test(nic) ? "text-muted" : ""}`}>
                    <td className="max-w-36 truncate py-1.5">{nic}</td>
                    <td className="py-1.5 text-right">{bits(v.rx)}</td>
                    <td className="py-1.5 pl-3 text-right">{bits(v.tx)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Internet speed" icon={Gauge} className="xl:col-span-2"
          actions={
            <Button onClick={runTest} disabled={running} icon={running ? Loader2 : Play}>
              {running ? "Testing… about 30 s" : "Run test"}
            </Button>
          }>
          {!st ? <Skeleton className="h-64" /> : last && !last.error ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <SpeedTile label="Download" value={last.down_mbps} unit="Mbps" />
                <SpeedTile label="Upload" value={last.up_mbps} unit="Mbps" />
                <SpeedTile label="Ping" value={last.ping_ms} unit="ms" sub={last.jitter_ms != null ? `jitter ${last.jitter_ms.toFixed(1)} ms` : undefined} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                <Globe size={12} aria-hidden />
                <span>{last.isp}</span>·<span>{last.server}</span>·<span>{dateTime(last.ts)}</span>
                {last.loss != null && <Tag>{last.loss.toFixed(1)}% loss</Tag>}
                {last.url && <a href={last.url} target="_blank" rel="noreferrer" className="text-fg-2 underline underline-offset-4 hover:text-fg">Ookla result</a>}
              </div>
            </>
          ) : last?.error ? (
            <Status state="bad">Last test failed: {last.error}</Status>
          ) : (
            <Empty icon={Gauge}>No tests yet. They run automatically on the interval set in Settings.</Empty>
          )}

          {ok.length === 1 && <p className="mt-6 text-xs text-muted">A history chart appears after the second test.</p>}
          {ok.length > 1 && (
            <div className="mt-6">
              <Legend items={[{ label: "Download", color: SLOT.blue }, { label: "Upload", color: SLOT.orange }]} />
              <div className="mt-3 h-52">
                <ResponsiveContainer>
                  <BarChart data={ok.slice(-24)} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={2}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="ts" tickFormatter={(t) => dateTime(t)} tick={tick} minTickGap={48} tickLine={false} axisLine={{ stroke: GRID }} />
                    <YAxis tick={tick} width={44} tickLine={false} axisLine={false} />
                    <Tooltip
                      cursor={{ fill: "#1e293b", fillOpacity: 0.5 }}
                      contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
                      labelStyle={{ color: AXIS_TEXT }}
                      itemStyle={{ color: "#f8fafc" }}
                      labelFormatter={(t) => dateTime(Number(t))}
                      formatter={(v) => `${Number(v).toFixed(1)} Mbps`}
                    />
                    <Bar dataKey="down_mbps" name="Download" fill={SLOT.blue} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                    <Bar dataKey="up_mbps" name="Upload" fill={SLOT.orange} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Traffic history" icon={History} className="mt-4"
        actions={<Segmented label="Range" value={range} options={RANGES} onChange={setRange} />}>
        {hist == null ? <Skeleton className="h-[280px]" /> : hist.length === 0 ? (
          <Empty icon={History}>No history yet.</Empty>
        ) : (
          <TimeChart data={hist} longRange={isLong(range)} height={260} format={(v) => bits(v)} axisFormat={bitsAxis}
            series={[{ key: "net_rx", label: "Download", color: SLOT.blue }, { key: "net_tx", label: "Upload", color: SLOT.orange }]} />
        )}
      </Card>
    </>
  );
}

function SpeedTile({ label, value, unit, sub }: { label: string; value: number | null; unit: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-bg p-4">
      <Kpi label={label} value={value != null ? value.toFixed(value < 10 ? 1 : 0) : "–"} unit={unit} sub={sub} />
    </div>
  );
}

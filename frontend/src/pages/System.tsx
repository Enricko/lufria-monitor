import { Activity, Cpu, Fan, History, ListOrdered, MemoryStick, MonitorSmartphone, Thermometer } from "lucide-react";
import { useState } from "react";
import { usePoll, type Live } from "../api";
import { TimeChart } from "../components/charts";
import { GpuCard, isAsleep } from "../components/GpuCard";
import { Card, Empty, Kpi, Meter, PageHeader, Row, Segmented, Skeleton, Tag } from "../components/ui";
import { bytes, rate, severity, temp } from "../format";
import { SLOT } from "../palette";
import { isLong, RANGES, type HistoryRow, type Range } from "../ranges";

type Proc = { pid: number; name: string; user: string; cpu: number; rss: number; cmd: string };

const PROFILE_LABEL: Record<string, string> = { quiet: "Quiet", balanced: "Balanced", performance: "Performance" };

export function System({ live, history }: { live: Live | null; history: Live[] }) {
  const [range, setRange] = useState<Range>("6h");
  const { data: hist } = usePoll<HistoryRow[]>(`/api/history?range=${range}`, 60000);
  const { data: procs } = usePoll<{ by_cpu: Proc[]; by_mem: Proc[]; count: number }>("/api/processes", 3000);
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const long = isLong(range);
  const awakeRows = (hist ?? []).filter((r) => r.gpu_awake != null);
  const awakeShare = awakeRows.length ? awakeRows.reduce((s, r) => s + (r.gpu_awake ?? 0), 0) / awakeRows.length : null;
  const fan = (label: string) => live?.fans.find((f) => f.label === label)?.rpm ?? null;
  const namedTemps = live ? [
    { label: "CPU package", v: live.temps.cpu },
    { label: "GPU", v: isAsleep(live.gpu.nvidia) ? null : live.temps.gpu },
    { label: "NVMe SSD", v: live.temps.nvme },
    { label: "Chipset (PCH)", v: live.temps.pch },
    { label: "Mainboard (ACPI)", v: live.temps.acpi },
  ] : [];

  return (
    <>
      <PageHeader title="System" description="Processor, memory, graphics, temperatures and processes" />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Processor" icon={Cpu} className="xl:col-span-2"
          actions={live && <span className="tnum font-mono text-xs text-muted">load {live.cpu.load.map((l) => l.toFixed(2)).join(" · ")}</span>}>
          {live ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {live.cpu.per_core.map((p, i) => (
                <div key={i} className="rounded-xl bg-bg p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-muted">CPU {i}</span>
                    <span className="tnum font-mono text-sm">{p.toFixed(0)}%</span>
                  </div>
                  <Meter className="mt-2" label={`CPU ${i} usage`} value={p} severity={severity(p)} />
                </div>
              ))}
            </div>
          ) : <Skeleton className="h-40" />}
          {live && live.temps.cores.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {live.temps.cores.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-lg bg-bg px-2.5 py-1.5 text-xs">
                  <Thermometer size={12} className="text-muted" aria-hidden />
                  <span className="text-muted">Core {i}</span>
                  <span className="tnum font-mono">{temp(t)}</span>
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="Memory" icon={MemoryStick}>
          {live ? (
            <div className="space-y-5">
              <Kpi label="RAM in use" value={live.mem.percent.toFixed(0)} unit="%" sub={`${bytes(live.mem.used)} of ${bytes(live.mem.total)}`}>
                <Meter className="mt-3" label="RAM usage" value={live.mem.percent} severity={severity(live.mem.percent, 80, 92)} />
              </Kpi>
              <div>
                <div className="mb-1.5 flex justify-between text-xs">
                  <span className="text-muted">Swap</span>
                  <span className="tnum font-mono">{bytes(live.swap.used)} / {bytes(live.swap.total)}</span>
                </div>
                <Meter label="Swap usage" value={live.swap.percent} severity={severity(live.swap.percent, 50, 80)} />
              </div>
              <div className="divide-y divide-line">
                <Row label="Page cache" value={bytes(live.mem.cached)} />
                <Row label="Buffers" value={bytes(live.mem.buffers)} />
              </div>
            </div>
          ) : <Skeleton className="h-56" />}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <GpuCard nvidia={live?.gpu.nvidia} intel={live?.gpu.intel} history={history} gpuFan={fan("gpu_fan")}
            awakeShare={awakeShare} rangeLabel={range} />
        </div>
        <Card title="Thermals & fans" icon={Fan}
          actions={live?.profile && <Tag>{PROFILE_LABEL[live.profile] ?? live.profile} profile</Tag>}>
          {live ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <FanTile label="CPU fan" rpm={fan("cpu_fan")} />
                <FanTile label="GPU fan" rpm={fan("gpu_fan")} />
              </div>
              <div className="mt-4 divide-y divide-line">
                {namedTemps.map((t) => (
                  <Row key={t.label} label={t.label} value={t.v == null ? (t.label === "GPU" ? "asleep" : "–") : temp(t.v)} />
                ))}
              </div>
            </>
          ) : <Skeleton className="h-64" />}
        </Card>
      </div>

      <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><History size={18} className="text-muted" aria-hidden />History</h2>
        <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <HistoryCard title="CPU & memory" icon={Activity} hist={hist}>
          {(h) => (
            <TimeChart data={h} longRange={long} max={100} format={(v) => `${v.toFixed(0)}%`}
              series={[{ key: "cpu", label: "CPU", color: SLOT.blue }, { key: "mem", label: "Memory", color: SLOT.orange }]} />
          )}
        </HistoryCard>
        <HistoryCard title="Temperatures" icon={Thermometer} hist={hist}>
          {(h) => (
            <TimeChart data={h} longRange={long} format={(v) => `${v.toFixed(0)}°C`}
              series={[
                { key: "cpu_temp", label: "CPU", color: SLOT.blue },
                { key: "nvme_temp", label: "NVMe", color: SLOT.aqua },
                ...(h.some((r) => r.gpu_temp != null) ? [{ key: "gpu_temp", label: "GPU", color: SLOT.magenta }] : []),
              ]} />
          )}
        </HistoryCard>
        <HistoryCard title="Disk I/O" icon={Activity} hist={hist}>
          {(h) => (
            <TimeChart data={h} longRange={long} format={(v) => rate(v)}
              series={[{ key: "disk_r", label: "Read", color: SLOT.blue }, { key: "disk_w", label: "Write", color: SLOT.orange }]} />
          )}
        </HistoryCard>
        <HistoryCard title="GPU load & video memory" icon={MonitorSmartphone} hist={hist}>
          {(h) => (
            <TimeChart data={h} longRange={long} max={100} format={(v) => `${v.toFixed(0)}%`}
              series={[{ key: "gpu_util", label: "GPU load", color: SLOT.blue }, { key: "gpu_vram", label: "VRAM", color: SLOT.orange }]} />
          )}
        </HistoryCard>
        <HistoryCard title="Fan speed" icon={Fan} hist={hist}>
          {(h) => (
            <TimeChart data={h} longRange={long} format={(v) => `${Math.round(v).toLocaleString("id-ID")} rpm`}
              axisFormat={(v) => `${(v / 1000).toFixed(1)}k`}
              series={[{ key: "fan_cpu", label: "CPU fan", color: SLOT.blue }, { key: "fan_gpu", label: "GPU fan", color: SLOT.orange }]} />
          )}
        </HistoryCard>
        <HistoryCard title="Load average (1 min)" icon={Activity} hist={hist}>
          {(h) => (
            <TimeChart data={h} longRange={long} format={(v) => v.toFixed(1)}
              series={[{ key: "load1", label: "Load", color: SLOT.blue }]} />
          )}
        </HistoryCard>
      </div>

      <Card title={`Processes${procs ? ` · ${procs.count}` : ""}`} icon={ListOrdered} className="mt-4"
        actions={<Segmented label="Sort by" value={sort} onChange={setSort} options={[{ value: "cpu", label: "CPU" }, { value: "mem", label: "Memory" }]} />}>
        {procs ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Process</th>
                  <th className="pb-2 font-medium">PID</th>
                  <th className="hidden pb-2 font-medium md:table-cell">User</th>
                  <th className="pb-2 text-right font-medium">CPU</th>
                  <th className="pb-2 text-right font-medium">Memory</th>
                </tr>
              </thead>
              <tbody>
                {(sort === "cpu" ? procs.by_cpu : procs.by_mem).map((p) => (
                  <tr key={p.pid} className="border-t border-line">
                    <td className="max-w-72 py-2 pr-3">
                      <div className="truncate">{p.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted" title={p.cmd}>{p.cmd || "kernel thread"}</div>
                    </td>
                    <td className="tnum py-2 pr-3 font-mono text-[13px] text-muted">{p.pid}</td>
                    <td className="hidden py-2 pr-3 text-muted md:table-cell">{p.user}</td>
                    <td className="tnum py-2 text-right font-mono text-[13px]">{p.cpu.toFixed(1)}%</td>
                    <td className="tnum py-2 pl-3 text-right font-mono text-[13px]">{bytes(p.rss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Skeleton className="h-80" />}
      </Card>
    </>
  );
}

function FanTile({ label, rpm }: { label: string; rpm: number | null }) {
  return (
    <div className="rounded-xl bg-bg p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold">{rpm != null ? rpm.toLocaleString("id-ID") : "–"}</div>
      <div className="text-xs text-muted">{rpm === 0 ? "stopped" : "rpm"}</div>
    </div>
  );
}

function HistoryCard({ title, icon, hist, children }: {
  title: string;
  icon: typeof Activity;
  hist: HistoryRow[] | null;
  children: (h: HistoryRow[]) => React.ReactNode;
}) {
  return (
    <Card title={title} icon={icon}>
      {hist == null ? <Skeleton className="h-[250px]" /> : hist.length === 0 ? (
        <Empty icon={History}>No history yet. Samples are saved once per minute.</Empty>
      ) : children(hist)}
    </Card>
  );
}

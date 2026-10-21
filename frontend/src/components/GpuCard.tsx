import { Moon, MonitorSmartphone, Zap } from "lucide-react";
import type { IntelGpu, Live, NvidiaGpu } from "../api";
import { severity, watts } from "../format";
import { SLOT } from "../palette";
import { StreamChart } from "./charts";
import { Card, Empty, Kpi, Meter, Row, Status, Tag } from "./ui";

/** Runtime PM states other than active/resuming mean the dGPU is (going) off. */
export const isAsleep = (nv: NvidiaGpu | null | undefined) => !!nv && nv.state !== "active" && nv.state !== "resuming";

export function nvidiaStatus(nv: NvidiaGpu | null | undefined): { state: "good" | "warn" | "unknown"; label: string } {
  if (!nv) return { state: "unknown", label: "not found" };
  if (nv.driver !== "nvidia") return { state: "warn", label: `${nv.driver ?? "no"} driver` };
  return isAsleep(nv) ? { state: "good", label: "sleeping" } : { state: "good", label: "active" };
}

export function GpuCard({ nvidia, intel, history, gpuFan, awakeShare, rangeLabel }: {
  nvidia: NvidiaGpu | null | undefined;
  intel: IntelGpu | null | undefined;
  history: Live[];
  gpuFan?: number | null;
  awakeShare?: number | null;
  rangeLabel?: string;
}) {
  const st = nvidiaStatus(nvidia);
  const m = nvidia?.metrics;
  const asleep = isAsleep(nvidia);
  const vramPct = m?.vram_total_mib ? ((m.vram_used_mib ?? 0) / m.vram_total_mib) * 100 : 0;
  const stream = history.map((h) => ({
    ts: h.ts,
    util: isAsleep(h.gpu?.nvidia) ? 0 : h.gpu?.nvidia?.metrics?.util ?? null,
    power: h.power.components?.gpu ?? null,
  }));

  return (
    <Card title="Graphics" icon={MonitorSmartphone}
      actions={awakeShare != null && rangeLabel && (
        <span className="text-xs text-muted">dGPU awake {(awakeShare * 100).toFixed(awakeShare < 0.1 ? 1 : 0)}% of the last {rangeLabel}</span>
      )}>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="rounded-xl bg-bg p-4 xl:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="font-medium">{nvidia?.name ?? "NVIDIA GPU"}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {nvidia?.driver && <Tag>driver {nvidia.driver}</Tag>}
                {nvidia?.power_state && <Tag>{nvidia.power_state}</Tag>}
                {!asleep && m?.pstate && <Tag>{m.pstate}</Tag>}
                {m?.vram_total_mib && <Tag>{(m.vram_total_mib / 1024).toFixed(0)} GB GDDR6</Tag>}
              </div>
            </div>
            <Status state={st.state}>{st.label}</Status>
          </div>

          {!nvidia ? (
            <Empty icon={MonitorSmartphone}>No NVIDIA GPU found.</Empty>
          ) : nvidia.driver !== "nvidia" ? (
            <p className="mt-4 text-sm text-muted">Running on the {nvidia.driver} driver: no CUDA and no power telemetry.</p>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Kpi label={nvidia.power_estimated ? "Power (estimated)" : "Power"} value={asleep ? "0" : nvidia.power_w?.toFixed(1) ?? "–"} unit="W"
                  sub={asleep ? "powered off" : m?.power_limit_w ? `limit ${watts(m.power_limit_w, 0)}` : m?.pstate ?? undefined} />
                <Kpi label="Load" value={asleep ? "0" : m?.util?.toFixed(0) ?? "–"} unit="%"
                  sub={!asleep && m?.clock_mhz != null ? `${m.clock_mhz} / ${m.clock_max_mhz} MHz` : undefined}>
                  <Meter className="mt-2" label="GPU load" value={asleep ? 0 : m?.util ?? 0} severity={severity(m?.util)} />
                </Kpi>
                <Kpi label="VRAM" value={asleep ? "off" : m?.vram_used_mib != null ? (m.vram_used_mib / 1024).toFixed(1) : "–"} unit={asleep ? undefined : "GB"}
                  sub={!asleep && m?.vram_total_mib ? `${vramPct.toFixed(0)}% in use` : undefined}>
                  <Meter className="mt-2" label="VRAM in use" value={asleep ? 0 : vramPct} severity={severity(vramPct, 85, 95)} />
                </Kpi>
                <Kpi label="Temperature" value={!asleep && m?.temp != null ? m.temp.toFixed(0) : "–"} unit="°C"
                  sub={gpuFan != null ? `GPU fan ${gpuFan.toLocaleString("id-ID")} rpm` : undefined}>
                  <Meter className="mt-2" label="GPU temperature" value={asleep ? 0 : m?.temp ?? 0} severity={severity(m?.temp, 80, 90)} />
                </Kpi>
              </div>

              {asleep ? (
                <div className="mt-5 flex items-start gap-3 rounded-lg border border-line p-3 text-sm text-muted">
                  <Moon size={18} className="mt-0.5 shrink-0" aria-hidden />
                  <p>Powered off (runtime D3cold) with video memory off, so it draws about 0 W. It wakes by itself when a program
                    uses CUDA, OpenCL or NVENC, and powers down again a few seconds after it finishes.</p>
                </div>
              ) : (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="text-xs text-muted">Load</div>
                    <StreamChart data={stream} height={130} max={100} format={(v) => `${v.toFixed(0)}%`}
                      series={[{ key: "util", label: "Load", color: SLOT.blue }]} />
                  </div>
                  <div>
                    <div className="text-xs text-muted">Power</div>
                    <StreamChart data={stream} height={130} format={(v) => `${v.toFixed(0)} W`}
                      series={[{ key: "power", label: "Power", color: SLOT.magenta }]} />
                  </div>
                </div>
              )}

              {!asleep && nvidia.procs.length > 0 && (
                <div className="mt-4 border-t border-line pt-2">
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-muted"><Zap size={12} aria-hidden />Using the GPU</div>
                  <div className="divide-y divide-line">
                    {nvidia.procs.map((p) => (
                      <Row key={p.pid} label={<span className="font-mono text-[13px]">{p.name}</span>}
                        sub={<span className="font-mono text-[11px] text-muted">pid {p.pid}</span>}
                        value={p.vram_mib != null ? `${p.vram_mib.toFixed(0)} MiB` : "–"} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="rounded-xl bg-bg p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="font-medium">{intel?.name ?? "Intel graphics"}</div>
            <Tag>i915</Tag>
          </div>
          {intel ? (
            <div className="mt-4 space-y-4">
              <Kpi label="Busy" value={intel.busy?.toFixed(0) ?? "–"} unit="%" sub="time outside RC6 power-saving">
                <Meter className="mt-2" label="iGPU busy" value={intel.busy ?? 0} severity={severity(intel.busy)} />
              </Kpi>
              <div className="divide-y divide-line">
                <Row label="Clock" value={`${intel.freq_mhz ?? "–"} MHz`} />
                <Row label="Range" value={`${intel.min_mhz ?? "–"}–${intel.max_mhz ?? "–"} MHz`} />
              </div>
              <p className="text-xs text-muted">Drives the built-in display. Its power is part of the CPU package reading.</p>
            </div>
          ) : <Empty icon={MonitorSmartphone}>Not available.</Empty>}
        </div>
      </div>
    </Card>
  );
}

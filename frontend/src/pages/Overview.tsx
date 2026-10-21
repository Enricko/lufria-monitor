import { Activity, ArrowDown, ArrowUp, HardDrive, Monitor, Server, Zap } from "lucide-react";
import { useMemo } from "react";
import { usePoll, type Live } from "../api";
import { Sparkline, StreamChart } from "../components/charts";
import { isAsleep, nvidiaStatus } from "../components/GpuCard";
import { PowerBreakdown } from "../components/PowerBreakdown";
import { Card, Kpi, Meter, PageHeader, Row, Skeleton, Status } from "../components/ui";
import { bits, bytes, duration, kwh, rate, rupiah, severity, temp } from "../format";
import { ACCENT, SLOT } from "../palette";

type Specs = {
  hostname: string;
  vendor: string;
  product: string;
  bios: string;
  os: string;
  kernel: string;
  arch: string;
  cpu: { model: string; cores: number; threads: number; max_mhz: number | null };
  memory_total: number;
  swap_total: number;
  gpus: string[];
  gpu_drivers: string[];
  disks: { name: string; size: number; model: string; rotational: boolean; transport: string | null }[];
  nics: { name: string; ipv4: string[]; up: boolean; speed_mbps: number }[];
};

type PowerSummary = {
  totals: Record<string, { kwh: number; cost: number; avg_w: number | null }>;
  projection: { cost_month: number; kwh_month: number } | null;
};

type ServicesSummary = {
  systemd: { watched: { unit: string; active: string; load: string }[]; failed: unknown[] };
  docker: { available: boolean; containers: { state: string }[] };
  tunnel: { routes: { hostname: string; up: boolean | null }[] };
};

export function Overview({ live, history }: { live: Live | null; history: Live[] }) {
  const { data: specs } = usePoll<Specs>("/api/specs");
  const { data: power } = usePoll<PowerSummary>("/api/power/summary", 30000);
  const { data: svc } = usePoll<ServicesSummary>("/api/services", 30000);

  const last60 = history.slice(-60);
  const stream = useMemo(
    () => history.map((h) => ({ ts: h.ts, cpu: h.cpu.percent, mem: h.mem.percent })),
    [history],
  );

  const watched = svc?.systemd.watched.filter((s) => s.load !== "not-found") ?? [];
  const healthy = watched.filter((s) => s.active === "active").length;
  const routesUp = svc?.tunnel.routes.filter((r) => r.up).length ?? 0;
  const running = svc?.docker.containers.filter((c) => c.state === "running").length ?? 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          specs ? `${specs.vendor} ${specs.product} · ${specs.os} · up ${live ? duration(live.uptime) : "–"}` : "Loading system…"
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Card>
          {live ? (
            <Kpi label="CPU" value={live.cpu.percent.toFixed(0)} unit="%"
              sub={`${live.cpu.freq_mhz ? (live.cpu.freq_mhz / 1000).toFixed(2) + " GHz · " : ""}load ${live.cpu.load[0].toFixed(2)}`}>
              <Meter className="mt-3" label="CPU usage" value={live.cpu.percent} severity={severity(live.cpu.percent)} />
              <Sparkline values={last60.map((h) => h.cpu.percent)} color={SLOT.blue} max={100} />
            </Kpi>
          ) : <TileSkeleton />}
        </Card>
        <Card>
          {live ? (
            <Kpi label="Memory" value={live.mem.percent.toFixed(0)} unit="%" sub={`${bytes(live.mem.used)} of ${bytes(live.mem.total)}`}>
              <Meter className="mt-3" label="Memory usage" value={live.mem.percent} severity={severity(live.mem.percent, 80, 92)} />
              <Sparkline values={last60.map((h) => h.mem.percent)} color={SLOT.orange} max={100} />
            </Kpi>
          ) : <TileSkeleton />}
        </Card>
        <Card>
          {live ? (
            <Kpi label="CPU temperature" value={live.temps.cpu?.toFixed(0) ?? "–"} unit="°C"
              sub={`NVMe ${temp(live.temps.nvme)} · PCH ${temp(live.temps.pch)}`}>
              <Meter className="mt-3" label="CPU temperature" value={live.temps.cpu ?? 0} severity={severity(live.temps.cpu, 75, 90)} />
              <Sparkline values={last60.map((h) => h.temps.cpu ?? 0)} color={SLOT.magenta} max={100} />
            </Kpi>
          ) : <TileSkeleton />}
        </Card>
        <Card>
          {live ? <GpuTile live={live} history={last60} /> : <TileSkeleton />}
        </Card>
        <Card>
          {live ? (
            <Kpi label="Power draw" value={live.power.total?.toFixed(1) ?? "–"} unit="W"
              sub={power ? `Today ${rupiah(power.totals.today?.cost)} · ${kwh(power.totals.today?.kwh)}` : "…"}>
              <div className="mt-3 h-1.5" />
              <Sparkline values={last60.map((h) => h.power.total ?? 0)} color={ACCENT} />
            </Kpi>
          ) : <TileSkeleton />}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="CPU & memory · last 2 minutes" icon={Activity} className="xl:col-span-2">
          {stream.length > 1 ? (
            <StreamChart data={stream} height={240} max={100} format={(v) => `${v.toFixed(0)}%`}
              series={[{ key: "cpu", label: "CPU", color: SLOT.blue }, { key: "mem", label: "Memory", color: SLOT.orange }]} />
          ) : <Skeleton className="h-[280px]" />}
        </Card>
        <Card title="Where the power goes" icon={Zap}
          actions={<a href="#power" className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline">Details</a>}>
          <PowerBreakdown power={live?.power} compact />
          {power?.projection && (
            <div className="mt-4 rounded-xl bg-bg p-3 text-sm">
              <div className="text-xs text-muted">Projected this month</div>
              <div className="mt-0.5 text-xl font-semibold">{rupiah(power.projection.cost_month)}</div>
              <div className="text-xs text-muted">{power.projection.kwh_month.toFixed(1)} kWh at the last 24h average</div>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Network" icon={Activity}>
          <div className="grid grid-cols-2 gap-4">
            <Kpi label="Download" value={bits(live?.net.rx)} sub={<span className="inline-flex items-center gap-1"><ArrowDown size={12} aria-hidden />all interfaces</span>} />
            <Kpi label="Upload" value={bits(live?.net.tx)} sub={<span className="inline-flex items-center gap-1"><ArrowUp size={12} aria-hidden />all interfaces</span>} />
          </div>
          <Sparkline values={last60.map((h) => h.net.rx + h.net.tx)} color={SLOT.blue} />
        </Card>
        <Card title="Disk activity" icon={HardDrive}>
          <div className="grid grid-cols-2 gap-4">
            <Kpi label="Read" value={rate(live?.disk.r)} />
            <Kpi label="Write" value={rate(live?.disk.w)} />
          </div>
          <Sparkline values={last60.map((h) => h.disk.r + h.disk.w)} color={SLOT.aqua} />
        </Card>
        <Card title="Health" icon={Server}
          actions={<a href="#services" className="text-xs text-muted underline-offset-4 hover:text-fg hover:underline">Services</a>}>
          {svc ? (
            <div className="divide-y divide-line">
              <Row label="Services" value={<Status state={healthy === watched.length ? "good" : "bad"}>{healthy}/{watched.length} running</Status>} />
              <Row label="Tunnel routes" value={<Status state={routesUp === svc.tunnel.routes.length ? "good" : "warn"}>{routesUp}/{svc.tunnel.routes.length} up</Status>} />
              <Row label="Containers" value={svc.docker.available
                ? <Status state={running === svc.docker.containers.length ? "good" : "warn"}>{running}/{svc.docker.containers.length} running</Status>
                : <Status state="unknown">no access</Status>} />
              <Row label="Failed units" value={<Status state={svc.systemd.failed.length ? "bad" : "good"}>{svc.systemd.failed.length}</Status>} />
              <Row label="NVIDIA GPU" value={(() => {
                const st = nvidiaStatus(live?.gpu.nvidia);
                return <Status state={st.state}>{st.label}</Status>;
              })()} />
            </div>
          ) : <Skeleton className="h-36" />}
        </Card>
      </div>

      <Card title="System" icon={Monitor} className="mt-4">
        {specs ? (
          <dl className="grid gap-x-10 gap-y-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
            <Spec k="Machine" v={`${specs.vendor} ${specs.product}`} />
            <Spec k="Processor" v={`${specs.cpu.model}\n${specs.cpu.cores} cores · ${specs.cpu.threads} threads${specs.cpu.max_mhz ? ` · up to ${(specs.cpu.max_mhz / 1000).toFixed(1)} GHz` : ""}`} />
            <Spec k="Memory" v={`${bytes(specs.memory_total)} RAM · ${bytes(specs.swap_total)} swap`} />
            <Spec k="Graphics" v={specs.gpus.map((g, i) => `${g.replace(/ Corporation/g, "")}${specs.gpu_drivers[i] ? ` · ${specs.gpu_drivers[i]}` : ""}`).join("\n")} />
            <Spec k="Storage" mono v={specs.disks.map((d) => `${d.name} · ${bytes(d.size, 0)} · ${d.model} (${d.transport === "usb" ? "USB" : d.rotational ? "HDD" : "SSD"})`).join("\n")} />
            <Spec k="Network" mono v={specs.nics.filter((n) => n.ipv4.length && !/^(docker|br-|veth)/.test(n.name)).map((n) => `${n.name} · ${n.ipv4.join(", ")}`).join("\n")} />
            <Spec k="Operating system" v={`${specs.os} · ${specs.arch}`} />
            <Spec k="Kernel" mono v={specs.kernel} />
            <Spec k="BIOS" mono v={specs.bios} />
          </dl>
        ) : <Skeleton className="h-40" />}
      </Card>
    </>
  );
}

function GpuTile({ live, history }: { live: Live; history: Live[] }) {
  const nv = live.gpu.nvidia;
  const asleep = isAsleep(nv);
  const m = nv?.metrics;
  if (!nv || nv.driver !== "nvidia") {
    return <Kpi label="GPU" value="–" sub={nv ? `${nv.driver} driver` : "not found"} />;
  }
  return (
    <Kpi label="Discrete GPU" value={asleep ? "Asleep" : m?.util?.toFixed(0) ?? "–"} unit={asleep ? undefined : "%"}
      sub={asleep ? "D3cold · 0 W" : `${nv.power_w?.toFixed(1) ?? "–"} W · ${m?.temp ?? "–"}°C · ${((m?.vram_used_mib ?? 0) / 1024).toFixed(1)} GB VRAM`}>
      <Meter className="mt-3" label="GPU load" value={asleep ? 0 : m?.util ?? 0} severity={severity(m?.util)} />
      <Sparkline values={history.map((h) => (isAsleep(h.gpu?.nvidia) ? 0 : h.gpu?.nvidia?.metrics?.util ?? 0))} color={SLOT.blue} max={100} />
    </Kpi>
  );
}

function TileSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-14" />
    </div>
  );
}

function Spec({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className={`mt-0.5 whitespace-pre-line break-words ${mono ? "font-mono text-[13px]" : ""}`}>{v || "–"}</dd>
    </div>
  );
}

import { Database, HardDrive } from "lucide-react";
import { usePoll, type Live } from "../api";
import { Card, Meter, PageHeader, Row, Skeleton, Status, Tag } from "../components/ui";
import { bytes, dateTime, rate, severity } from "../format";

type Smart = {
  available?: boolean;
  passed?: boolean | null;
  model?: string;
  temperature?: number | null;
  power_on_hours?: number | null;
  power_cycles?: number | null;
  reallocated?: number | null;
  pending?: number | null;
  percent_used?: number | null;
  data_written_tb?: number | null;
};

type StorageData = {
  mounts: { device: string; mountpoint: string; fstype: string; total: number; used: number; free: number; percent: number }[];
  disks: {
    name: string;
    size: number;
    model: string;
    rotational: boolean;
    transport: string | null;
    mounted: boolean;
    partitions: { name: string; size: number; fstype: string | null; mountpoints: string[] }[];
    smart: Smart;
  }[];
  smart_updated: number | null;
};

export function Storage({ live }: { live: Live | null }) {
  const { data } = usePoll<StorageData>("/api/storage", 30000);

  return (
    <>
      <PageHeader
        title="Storage"
        description={data?.smart_updated ? `SMART health refreshed every 30 minutes · last ${dateTime(data.smart_updated)}` : "Filesystems and disk health"}
      />

      <Card title="Filesystems" icon={Database}>
        {data ? (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {data.mounts.map((m) => (
              <div key={m.device} className="rounded-xl bg-bg p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm">{m.mountpoint}</div>
                    <div className="truncate text-xs text-muted">{m.device}</div>
                  </div>
                  <Tag>{m.fstype}</Tag>
                </div>
                <div className="mt-4 flex items-baseline justify-between">
                  <span className="text-2xl font-semibold">{m.percent.toFixed(0)}%</span>
                  <span className="tnum font-mono text-xs text-muted">{bytes(m.free)} free</span>
                </div>
                <Meter className="mt-2" label={`${m.mountpoint} usage`} value={m.percent} severity={severity(m.percent, 80, 90)} />
                <div className="tnum mt-2 font-mono text-xs text-muted">{bytes(m.used)} of {bytes(m.total)}</div>
              </div>
            ))}
          </div>
        ) : <Skeleton className="h-40" />}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {data ? data.disks.map((d) => {
          const io = live?.disk.per_disk[d.name];
          const s = d.smart;
          const health = !s.available ? "unknown" : s.passed ? (s.pending || s.reallocated ? "warn" : "good") : "bad";
          return (
            <Card key={d.name} title={<span className="font-mono">/dev/{d.name}</span>} icon={HardDrive}
              actions={<Status state={health}>{s.available ? (s.passed ? "Healthy" : "Failing") : "No SMART"}</Status>}>
              <div className="text-sm">{d.model || s.model || "Unknown model"}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Tag>{bytes(d.size, 0)}</Tag>
                <Tag>{d.transport === "usb" ? "USB" : d.rotational ? "HDD" : "SSD"}</Tag>
                {d.transport && <Tag>{d.transport.toUpperCase()}</Tag>}
                {!d.mounted && <Tag>not mounted</Tag>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <IoStat label="Read" value={rate(io?.r)} />
                <IoStat label="Write" value={rate(io?.w)} />
              </div>
              <div className="mt-3 divide-y divide-line">
                {s.temperature != null && <Row label="Temperature" value={`${s.temperature}°C`} />}
                {s.power_on_hours != null && <Row label="Power-on time" value={`${s.power_on_hours.toLocaleString("id-ID")} h`} />}
                {s.power_cycles != null && <Row label="Power cycles" value={s.power_cycles.toLocaleString("id-ID")} />}
                {s.percent_used != null && <Row label="Wear" value={`${s.percent_used}%`} />}
                {s.data_written_tb != null && <Row label="Data written" value={`${s.data_written_tb.toFixed(1)} TB`} />}
                {s.reallocated != null && <Row label="Reallocated sectors" value={s.reallocated} />}
                {s.pending != null && <Row label="Pending sectors" value={s.pending} />}
              </div>
              {d.partitions.length > 0 && (
                <div className="mt-3 rounded-lg bg-bg p-3">
                  <div className="mb-1 text-xs text-muted">Partitions</div>
                  {d.partitions.map((p) => (
                    <div key={p.name} className="tnum flex justify-between gap-2 py-0.5 font-mono text-xs">
                      <span className="truncate">{p.name}{p.fstype ? ` · ${p.fstype}` : ""}</span>
                      <span className="shrink-0 text-muted">{bytes(p.size, 0)}{p.mountpoints.length ? ` → ${p.mountpoints.join(", ")}` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        }) : [0, 1, 2].map((i) => <Skeleton key={i} className="h-80" />)}
      </div>
    </>
  );
}

function IoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="tnum font-mono text-sm">{value}</div>
    </div>
  );
}

import { Boxes, Cloud, ListChecks, Search, ServerCog, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { usePoll } from "../api";
import { Card, Empty, PageHeader, Skeleton, Status } from "../components/ui";
import { bytes } from "../format";

type Unit = { unit: string; active: string; sub: string; description: string };
type Watched = Unit & { load: string; enabled: string; since: string; memory: number | null; pid: number };
type ServicesData = {
  systemd: { watched: Watched[]; all: Unit[]; failed: Unit[]; running: number };
  docker: { available: boolean; error?: string; containers: { name: string; image: string; state: string; status: string; ports: string }[] };
  tunnel: { available: boolean; error?: string; routes: { hostname: string; service: string; up: boolean | null }[] };
};

export function Services() {
  const { data } = usePoll<ServicesData>("/api/services", 10000);
  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  if (!data) {
    return (
      <>
        <PageHeader title="Services" description="systemd, Docker and Cloudflare tunnel" />
        <div className="grid gap-4"><Skeleton className="h-72" /><Skeleton className="h-48" /></div>
      </>
    );
  }
  const { systemd, docker, tunnel } = data;
  const all = systemd.all.filter((u) => `${u.unit} ${u.description}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <PageHeader
        title="Services"
        description={`${systemd.running} services running · ${systemd.failed.length} failed · refreshes every 10 s`}
      />

      {systemd.failed.length > 0 && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-2xl border border-bad/40 bg-bad/10 p-4 text-sm">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />
          <div>
            <div className="font-medium">Failed units</div>
            {systemd.failed.map((u) => <div key={u.unit} className="font-mono text-[13px] text-fg-2">{u.unit}</div>)}
          </div>
        </div>
      )}

      <Card title="Watched services" icon={ListChecks}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Service</th>
                <th className="pb-2 font-medium">State</th>
                <th className="hidden pb-2 font-medium md:table-cell">On boot</th>
                <th className="hidden pb-2 font-medium lg:table-cell">Since</th>
                <th className="pb-2 text-right font-medium">Memory</th>
              </tr>
            </thead>
            <tbody>
              {systemd.watched.map((s) => {
                const missing = s.load === "not-found";
                return (
                  <tr key={s.unit} className="border-t border-line">
                    <td className="py-2.5 pr-3">
                      <div className="font-mono text-[13px]">{s.unit.replace(/\.service$/, "")}</div>
                      <div className="text-xs text-muted">{missing ? "not installed" : s.description}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Status state={missing ? "unknown" : s.active === "active" ? "good" : s.active === "failed" ? "bad" : "warn"}>
                        {missing ? "missing" : s.sub || s.active}
                      </Status>
                    </td>
                    <td className="hidden py-2.5 pr-3 text-muted md:table-cell">{s.enabled}</td>
                    <td className="hidden py-2.5 pr-3 text-xs text-muted lg:table-cell">{s.since}</td>
                    <td className="tnum py-2.5 text-right font-mono text-[13px]">{bytes(s.memory)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Cloudflare tunnel" icon={Cloud}>
          {tunnel.available ? (
            <ul className="divide-y divide-line">
              {tunnel.routes.map((r) => (
                <li key={r.hostname} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <a href={`https://${r.hostname}`} target="_blank" rel="noreferrer" className="text-sm underline-offset-4 hover:underline">{r.hostname}</a>
                    <div className="truncate font-mono text-[11px] text-muted">→ {r.service}</div>
                  </div>
                  <Status state={r.up == null ? "unknown" : r.up ? "good" : "bad"}>{r.up == null ? "unknown" : r.up ? "backend up" : "backend down"}</Status>
                </li>
              ))}
            </ul>
          ) : <Status state="bad">{tunnel.error}</Status>}
        </Card>

        <Card title="Docker containers" icon={Boxes}>
          {!docker.available ? (
            <Empty icon={Boxes}>Docker is not accessible: {docker.error}</Empty>
          ) : docker.containers.length === 0 ? (
            <Empty icon={Boxes}>No containers.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {docker.containers.map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm">{c.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted">{c.image} · {c.status}</div>
                  </div>
                  <Status state={c.state === "running" ? "good" : c.state === "exited" ? "bad" : "warn"}>{c.state}</Status>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`All services · ${systemd.all.length}`} icon={ServerCog} className="mt-4"
        actions={
          <label className="relative">
            <span className="sr-only">Filter services</span>
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="h-9 w-48 rounded-lg border border-line-strong bg-bg pl-8 pr-3 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </label>
        }>
        <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
          {(showAll || filter ? all : all.slice(0, 24)).map((u) => (
            <div key={u.unit} className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-1.5 text-sm" title={u.description}>
              <span className="truncate font-mono text-[13px] text-fg-2">{u.unit.replace(/\.service$/, "")}</span>
              <span className={`shrink-0 text-xs ${u.active === "failed" ? "text-bad" : u.sub === "running" ? "text-fg-2" : "text-muted"}`}>
                {u.active === "failed" ? "failed" : u.sub}
              </span>
            </div>
          ))}
        </div>
        {!filter && all.length > 24 && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="mt-3 h-10 cursor-pointer rounded-md px-2 text-sm text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
          >
            {showAll ? "Show fewer" : `Show all ${all.length}`}
          </button>
        )}
      </Card>
    </>
  );
}

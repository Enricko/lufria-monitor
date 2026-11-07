import type { LucideIcon } from "lucide-react";
import { ExternalLink, Layers, LoaderCircle, Pencil, Play, Plus, RotateCw, ScrollText, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, usePoll } from "../api";
import { bytes, duration } from "../format";
import { Modal } from "./Modal";
import { ServiceEditor } from "./ServiceEditor";
import { Button, Card, Empty, Status } from "./ui";

export type ServiceKind = "systemd" | "user" | "docker" | "command";
export type ServiceSpec = {
  id: string;
  name: string;
  kind: ServiceKind;
  parent: string | null;
  target: string;
  command: string;
  cwd: string;
  match: string;
  log: string;
  ready: string;
  url: string;
  stop_timeout: number;
};
type State = "running" | "external" | "starting" | "stopping" | "stopped" | "failed" | "missing" | "unknown";
export type ManagedService = ServiceSpec & {
  status: { state: State; detail: string; since: number | null; memory: number | null; boot: string; unit?: string };
  busy: string | null;
  error: { action: string; message: string; ts: number } | null;
};
type ManagedData = { services: ManagedService[]; error: string | null; self_unit: string };
type Action = "start" | "stop" | "restart";

const UP: State[] = ["running", "external", "starting"];
export const isUp = (s: ManagedService) => UP.includes(s.status.state);

export const KIND_LABEL: Record<ServiceKind, string> = { systemd: "unit", user: "user unit", docker: "container", command: "command" };

const STATE: Record<State, { tone: "good" | "warn" | "bad" | "unknown"; label: string }> = {
  running: { tone: "good", label: "running" },
  external: { tone: "good", label: "running" },
  starting: { tone: "warn", label: "starting" },
  stopping: { tone: "warn", label: "stopping" },
  stopped: { tone: "unknown", label: "stopped" },
  failed: { tone: "bad", label: "failed" },
  missing: { tone: "unknown", label: "not found" },
  unknown: { tone: "unknown", label: "unknown" },
};
const BUSY_LABEL: Record<string, string> = { waiting: "queued", starting: "starting", stopping: "stopping", restarting: "restarting" };

/** "409 {"detail":"…"}" from api() -> "…" */
export function errorText(e: unknown): string {
  const m = String(e instanceof Error ? e.message : e).match(/^\d{3} (.*)$/s);
  if (!m) return String(e);
  try {
    const d = JSON.parse(m[1]).detail;
    return typeof d === "string" ? d : m[1];
  } catch {
    return m[1];
  }
}

function childrenMap(list: ManagedService[]) {
  const ids = new Set(list.map((s) => s.id));
  const kids = new Map<string | null, ManagedService[]>();
  for (const s of list) {
    const key = s.parent && ids.has(s.parent) ? s.parent : null;
    kids.set(key, [...(kids.get(key) ?? []), s]);
  }
  return kids;
}

function descendants(id: string, kids: Map<string | null, ManagedService[]>): ManagedService[] {
  return (kids.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id, kids)]);
}

/** Services started, stopped and restarted from here, children nested under the service they run on. */
export function ManagedServices({ units, containers }: { units: string[]; containers: string[] }) {
  const [fast, setFast] = useState(false);
  const { data, error, reload } = usePoll<ManagedData>("/api/managed", fast ? 1500 : 10000);
  const [confirm, setConfirm] = useState<{ s: ManagedService; action: "stop" | "restart" } | null>(null);
  const [logs, setLogs] = useState<ManagedService | null>(null);
  const [editing, setEditing] = useState<ManagedService | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const list = useMemo(() => data?.services ?? [], [data]);
  const kids = useMemo(() => childrenMap(list), [list]);
  const byId = useMemo(() => new Map(list.map((s) => [s.id, s])), [list]);
  const moving = list.some((s) => s.busy || s.status.state === "starting" || s.status.state === "stopping");
  useEffect(() => setFast(moving), [moving]);

  const send = async (s: ManagedService, action: Action) => {
    setNotice(null);
    try {
      await api(`/api/managed/${encodeURIComponent(s.id)}/${action}`, { method: "POST" });
    } catch (e) {
      setNotice(errorText(e));
    }
    reload();
  };

  const ask = (s: ManagedService, action: Action) => {
    if (action === "start") void send(s, action);
    else setConfirm({ s, action });
  };

  const running = list.filter(isUp).length;
  const errorKey = (s: ManagedService) => `${s.id}:${s.error?.ts}`;

  const renderTree = (parent: string | null) => (
    <ul className={parent ? "ml-4 border-l border-line pl-3 sm:ml-5 sm:pl-4" : "divide-y divide-line"}>
      {(kids.get(parent) ?? []).map((s) => (
        <li key={s.id} className={parent ? "border-t border-line" : ""}>
          <ServiceRow
            s={s}
            byId={byId}
            onAction={(a) => ask(s, a)}
            onLogs={() => setLogs(s)}
            onEdit={() => setEditing(s)}
          />
          {s.error && !dismissed.has(errorKey(s)) && (
            <div role="alert" className="mb-2.5 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-bad">Couldn’t {s.error.action} {s.name}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setDismissed(new Set(dismissed).add(errorKey(s)))}
                  className="-mr-1.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
                  <X size={14} aria-hidden />
                </button>
              </div>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-2">{s.error.message}</pre>
            </div>
          )}
          {kids.has(s.id) && renderTree(s.id)}
        </li>
      ))}
    </ul>
  );

  return (
    <Card
      title={data && list.length > 0 ? `Managed services · ${running}/${list.length} running` : "Managed services"}
      icon={Layers}
      className="mb-4"
      actions={data && <Button icon={Plus} onClick={() => setEditing("new")}>Add service</Button>}
    >
      {notice && (
        <div role="alert" className="mb-3 flex items-start justify-between gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="cursor-pointer text-muted hover:text-fg"><X size={14} aria-hidden /></button>
        </div>
      )}
      {data?.error && <Status state="bad">{data.error}</Status>}
      {!data ? (
        error ? <Status state="bad">Couldn’t load the service list: {errorText(error)}</Status>
          : <div className="h-24 animate-pulse rounded-lg bg-surface-2" aria-hidden />
      ) : list.length === 0 ? (
        <Empty icon={Layers}>
          Add the services you want to start, stop and restart from here.
          <br />A service can run on top of another one, like a simulator on top of its API: it starts after it and stops before it.
        </Empty>
      ) : renderTree(null)}

      {confirm && (
        <ConfirmDialog
          s={confirm.s}
          action={confirm.action}
          affected={descendants(confirm.s.id, kids).filter(isUp)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { void send(confirm.s, confirm.action); setConfirm(null); }}
        />
      )}
      {logs && <LogsDialog s={logs} onClose={() => setLogs(null)} />}
      {editing && (
        <ServiceEditor
          service={editing === "new" ? null : editing}
          all={list}
          units={units}
          containers={containers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </Card>
  );
}

function IconButton({ label, icon: Icon, onClick, disabled, className = "" }: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${className}`}>
      <Icon size={16} aria-hidden />
    </button>
  );
}

function ServiceRow({ s, byId, onAction, onLogs, onEdit }: {
  s: ManagedService;
  byId: Map<string, ManagedService>;
  onAction: (a: Action) => void;
  onLogs: () => void;
  onEdit: () => void;
}) {
  const up = isUp(s);
  const st = STATE[s.status.state] ?? STATE.unknown;
  const what = s.kind === "command" ? s.command : `${KIND_LABEL[s.kind]} · ${s.target}`;
  const parentDown = (() => {
    const down: string[] = [];
    for (let p = s.parent ? byId.get(s.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) {
      if (!isUp(p)) down.unshift(p.name);
    }
    return down;
  })();
  const startLabel = parentDown.length ? `Start ${s.name} (starts ${parentDown.join(", ")} first)` : `Start ${s.name}`;
  const note = s.status.state === "external" ? "started outside the dashboard · restart to take it over"
    : s.status.state === "failed" || s.status.state === "missing" || s.status.state === "unknown" ? s.status.detail : "";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{s.name}</span>
          {s.url && (
            <a href={s.url} target="_blank" rel="noreferrer" aria-label={`Open ${s.name}`} title={s.url}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-fg">
              <ExternalLink size={13} aria-hidden />
            </a>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted" title={what}>{what}</div>
        {note && <div className={`truncate text-[11px] ${s.status.state === "external" ? "text-warn" : "text-muted"}`} title={note}>{note}</div>}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="tnum hidden w-24 text-right text-xs leading-tight text-muted md:block">
          {up && s.status.since ? <div>up {duration(Math.max(0, Date.now() / 1000 - s.status.since))}</div> : null}
          {up && s.status.memory ? <div>{bytes(s.status.memory)}</div> : null}
        </div>
        <div className="flex w-[6.5rem] justify-end">
          {s.busy ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">
              <LoaderCircle size={12} className="animate-spin" aria-hidden />
              {BUSY_LABEL[s.busy] ?? s.busy}…
            </span>
          ) : (
            <Status state={st.tone}>{st.label}</Status>
          )}
        </div>
        <div className="flex items-center">
          {up ? (
            <>
              <IconButton label={`Stop ${s.name}`} icon={Square} onClick={() => onAction("stop")} disabled={!!s.busy} />
              <IconButton label={`Restart ${s.name}`} icon={RotateCw} onClick={() => onAction("restart")} disabled={!!s.busy} />
            </>
          ) : (
            <>
              <IconButton label={startLabel} icon={Play} onClick={() => onAction("start")} disabled={!!s.busy || s.status.state === "stopping"}
                className="text-accent hover:text-accent" />
              <span className="size-9 shrink-0" aria-hidden />
            </>
          )}
          <IconButton label={`Logs of ${s.name}`} icon={ScrollText} onClick={onLogs} />
          <IconButton label={`Edit ${s.name}`} icon={Pencil} onClick={onEdit} />
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({ s, action, affected, onCancel, onConfirm }: {
  s: ManagedService;
  action: "stop" | "restart";
  affected: ManagedService[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const stop = action === "stop";
  const external = s.status.state === "external";
  return (
    <Modal
      title={`${stop ? "Stop" : "Restart"} ${s.name}?`}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <button type="button" data-autofocus onClick={onConfirm}
            className={`inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors duration-150 ${
              stop ? "bg-bad text-white hover:bg-bad/85" : "bg-accent text-bg hover:bg-accent/90"}`}>
            {stop ? <Square size={16} aria-hidden /> : <RotateCw size={16} aria-hidden />}
            {stop ? "Stop" : "Restart"}
          </button>
        </>
      }
    >
      <div className="space-y-3 px-5 py-4 text-sm text-fg-2">
        {affected.length > 0 && (
          <div>
            <p>{stop ? "These run on top of it and stop first:" : "These run on top of it: they stop first and start again after."}</p>
            <ul className="mt-1.5 space-y-1">
              {affected.map((a) => <li key={a.id} className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-muted" aria-hidden />{a.name}</li>)}
            </ul>
          </div>
        )}
        {external && (
          <p>It was started outside the dashboard. {stop ? "Its processes get SIGTERM, then SIGKILL after "
            + `${s.stop_timeout} s.` : `Its processes are stopped and it starts again as ${s.status.unit}, so it can be managed from here.`}</p>
        )}
        {stop && s.kind === "docker" && <p>Docker waits up to {s.stop_timeout} s for it to shut down cleanly.</p>}
        {affected.length === 0 && !external && !(stop && s.kind === "docker") && (
          <p className="text-muted">{s.kind === "command" ? s.command : `${KIND_LABEL[s.kind]} ${s.target}`}</p>
        )}
      </div>
    </Modal>
  );
}

function LogsDialog({ s, onClose }: { s: ManagedService; onClose: () => void }) {
  const [data, setData] = useState<{ source: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ source: string; text: string }>(`/api/managed/${encodeURIComponent(s.id)}/logs`)
        .then((d) => { if (alive) { setData(d); setError(null); } })
        .catch((e) => { if (alive) setError(errorText(e)); });
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [s.id]);

  useLayoutEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [data]);

  return (
    <Modal wide title={`Logs · ${s.name}`} subtitle={data ? <span className="font-mono">{data.source} · refreshes every 3 s</span> : "Loading…"} onClose={onClose}>
      {error && <p role="alert" className="m-4 rounded-lg border border-bad/30 bg-bad/10 p-2 text-xs text-bad">{error}</p>}
      <pre
        ref={pre}
        tabIndex={0}
        aria-label={`Log output of ${s.name}`}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24; }}
        className="h-[65dvh] overflow-auto whitespace-pre-wrap break-words bg-bg px-4 py-3 font-mono text-[11px] leading-relaxed text-fg-2 focus:outline-none"
      >
        {data ? data.text || "No log lines yet." : ""}
      </pre>
    </Modal>
  );
}

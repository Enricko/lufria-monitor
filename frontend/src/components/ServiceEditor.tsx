import { Save, Trash } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { errorText, isUp, type ManagedService, type ServiceKind, type ServiceSpec } from "./ManagedServices";
import { Modal } from "./Modal";
import { Button, Segmented } from "./ui";

const input =
  "h-10 w-full rounded-lg border border-line-strong bg-bg px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none";

const KINDS: { value: ServiceKind; label: string }[] = [
  { value: "command", label: "Command" },
  { value: "systemd", label: "Unit" },
  { value: "docker", label: "Container" },
  { value: "user", label: "User unit" },
];

const BLANK: ServiceSpec = {
  id: "", name: "", kind: "command", parent: null, target: "", command: "", cwd: "", match: "", log: "",
  ready: "", url: "", stop_timeout: 30,
};

const SPEC_KEYS = Object.keys(BLANK) as (keyof ServiceSpec)[];
const spec = (s: ServiceSpec): ServiceSpec => Object.fromEntries(SPEC_KEYS.map((k) => [k, s[k]])) as ServiceSpec;

function slug(name: string, taken: Set<string>) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34) || "service";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Add or edit one entry of the managed list; saves the whole list. */
export function ServiceEditor({ service, all, units, containers, onClose, onSaved }: {
  service: ManagedService | null;
  all: ManagedService[];
  units: string[];
  containers: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ServiceSpec>(service ? spec(service) : BLANK);
  const [timeout, setTimeout_] = useState(String(form.stop_timeout));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const uid = useId();
  const set = <K extends keyof ServiceSpec>(k: K, v: ServiceSpec[K]) => setForm((f) => ({ ...f, [k]: v }));

  const taken = useMemo(() => new Set(all.map((s) => s.id)), [all]);
  const id = service?.id ?? slug(form.name, taken);
  // can't sit on itself or on anything that runs on top of it
  const parents = useMemo(() => {
    if (!service) return all;
    const below = new Set([service.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const s of all) if (s.parent && below.has(s.parent) && !below.has(s.id)) { below.add(s.id); grew = true; }
    }
    return all.filter((s) => !below.has(s.id));
  }, [all, service]);

  const put = async (next: ServiceSpec[]) => {
    setSaving(true);
    setError(null);
    try {
      await api("/api/managed", { method: "PUT", body: JSON.stringify({ services: next.map(spec) }) });
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setSaving(false);
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const entry = { ...form, id, stop_timeout: Number(timeout) || 30 };
    void put(service ? all.map((s) => (s.id === service.id ? entry : spec(s))) : [...all.map(spec), entry]);
  };

  const remove = () => {
    if (!service) return;
    if (!deleting) { setDeleting(true); return; }
    // whatever ran on top of it moves down to its parent
    void put(all.filter((s) => s.id !== service.id)
      .map((s) => spec(s.parent === service.id ? { ...s, parent: service.parent } : s)));
  };

  const runningCommand = service?.kind === "command" && isUp(service);
  const f = (name: string) => `${uid}-${name}`;

  return (
    <Modal
      title={service ? `Edit ${service.name}` : "Add service"}
      subtitle={form.kind === "command" ? <span className="font-mono">runs as lufria-svc-{id}.service</span> : undefined}
      onClose={onClose}
      footer={
        <>
          {service && (
            <div className="mr-auto flex items-center gap-2">
              <button type="button" onClick={remove} disabled={saving || runningCommand}
                title={runningCommand ? "Stop it first: it would keep running with nothing here to stop it" : undefined}
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium text-bad transition-colors duration-150 hover:bg-bad/10 disabled:cursor-not-allowed disabled:opacity-40">
                <Trash size={15} aria-hidden />
                {deleting ? "Remove from list?" : "Remove"}
              </button>
            </div>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <button type="submit" form={f("form")} disabled={saving}
            className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-bg transition-colors duration-150 hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
            <Save size={16} aria-hidden />
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id={f("form")} onSubmit={save} className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        <Field id={f("name")} label="Name" className="sm:col-span-2">
          <input id={f("name")} className={input} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="AVTS simulation" maxLength={60} required />
        </Field>

        <div className="sm:col-span-2">
          <div className="mb-1.5 text-sm font-medium text-fg-2">Kind</div>
          <Segmented label="Kind" value={form.kind} options={KINDS} onChange={(k) => set("kind", k)} />
        </div>

        {form.kind === "command" ? (
          <>
            <Field id={f("command")} label="Command" className="sm:col-span-2"
              hint="Runs in your user session: it keeps running when the dashboard restarts, but isn’t started on boot. Quote arguments like a shell; use bash -c '…' for pipes.">
              <input id={f("command")} className={`${input} font-mono`} value={form.command} onChange={(e) => set("command", e.target.value)}
                placeholder="/home/lufria/bin/simulate -vessels 20" spellCheck={false} required />
            </Field>
            <Field id={f("cwd")} label="Working directory" hint="Default: your home folder.">
              <input id={f("cwd")} className={`${input} font-mono`} value={form.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="/home/lufria/project" spellCheck={false} />
            </Field>
            <Field id={f("log")} label="Log file" hint="Optional. Default: the user journal.">
              <input id={f("log")} className={`${input} font-mono`} value={form.log} onChange={(e) => set("log", e.target.value)} placeholder="/home/lufria/project/app.log" spellCheck={false} />
            </Field>
            <Field id={f("match")} label="Find copies started elsewhere" className="sm:col-span-2"
              hint="Optional regex on the full command line, e.g. ^/home/lufria/bin/api_server. Matching processes show as running and are taken over on stop or restart.">
              <input id={f("match")} className={`${input} font-mono`} value={form.match} onChange={(e) => set("match", e.target.value)} spellCheck={false} />
            </Field>
          </>
        ) : (
          <Field id={f("target")} label={form.kind === "docker" ? "Container" : "Unit"} className="sm:col-span-2"
            hint={form.kind === "systemd" ? "System unit, changed with sudo systemctl." : form.kind === "user" ? "Unit of your own systemd --user manager." : undefined}>
            <input id={f("target")} className={`${input} font-mono`} value={form.target} onChange={(e) => set("target", e.target.value)}
              list={form.kind === "user" ? undefined : f("targets")} placeholder={form.kind === "docker" ? "postgres" : "nginx.service"} spellCheck={false} required />
            <datalist id={f("targets")}>
              {(form.kind === "docker" ? containers : units).map((u) => <option key={u} value={u} />)}
            </datalist>
          </Field>
        )}

        <Field id={f("parent")} label="Runs on top of" className="sm:col-span-2"
          hint="Starting this starts that one first; stopping that one stops this first; restarting it brings this back.">
          <select id={f("parent")} className={`${input} cursor-pointer`} value={form.parent ?? ""} onChange={(e) => set("parent", e.target.value || null)}>
            <option value="">Nothing (top level)</option>
            {parents.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>

        <Field id={f("ready")} label="Ready when it answers on" hint="Optional: port, host:port or http:// URL. What runs on top waits for it.">
          <input id={f("ready")} className={`${input} font-mono`} value={form.ready} onChange={(e) => set("ready", e.target.value)} placeholder="127.0.0.1:3000" spellCheck={false} />
        </Field>
        <Field id={f("url")} label="Link" hint="Optional page to open.">
          <input id={f("url")} className={`${input} font-mono`} value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://app.lufria.tech" spellCheck={false} />
        </Field>
        {(form.kind === "command" || form.kind === "docker") && (
          <Field id={f("timeout")} label="Stop timeout (s)" hint="SIGTERM, then SIGKILL after this long.">
            <input id={f("timeout")} type="number" min={1} max={600} className={`${input} tnum`} value={timeout} onChange={(e) => setTimeout_(e.target.value)} />
          </Field>
        )}

        {service && form.kind === "command" && isUp(service) && (
          <p className="text-xs text-muted sm:col-span-2">Changes to the command apply the next time it starts or restarts.</p>
        )}
        {error && <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 p-2.5 text-xs text-bad sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
}

function Field({ id, label, hint, className = "", children }: { id: string; label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-fg-2">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

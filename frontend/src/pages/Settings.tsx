import { Check, Cog, PlugZap, Save } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, usePoll } from "../api";
import { Passkeys } from "../components/Passkeys";
import { Button, Card, PageHeader, Skeleton } from "../components/ui";
import { rupiahFine } from "../format";

type SettingsValues = {
  tariff_preset: string;
  tariff_rp_per_kwh: number;
  ppj_percent: number;
  overhead_watts: number;
  timezone: string;
  speedtest_interval_hours: number;
  watched_services: string[];
};
type SettingsData = {
  settings: SettingsValues;
  tariff_presets: Record<string, { label: string; rate: number | null }>;
};

const input =
  "h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";

export function Settings() {
  const { data, reload } = usePoll<SettingsData>("/api/settings");
  const [form, setForm] = useState<SettingsValues | null>(null);
  const [services, setServices] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");

  useEffect(() => {
    if (data) {
      setForm(data.settings);
      setServices(data.settings.watched_services.join(", "));
    }
  }, [data]);

  if (!data || !form) {
    return (
      <>
        <PageHeader title="Settings" />
        <Skeleton className="h-96 max-w-3xl" />
      </>
    );
  }
  const set = <K extends keyof SettingsValues>(k: K, v: SettingsValues[K]) => setForm({ ...form, [k]: v });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("saving");
    try {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ ...form, watched_services: services.split(",").map((s) => s.trim()).filter(Boolean) }),
      });
      setState("saved");
      reload();
      setTimeout(() => setState("idle"), 2500);
    } catch (err) {
      setState(String(err));
    }
  };

  const effective = form.tariff_rp_per_kwh * (1 + form.ppj_percent / 100);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" description="Tariff, power model, monitoring and sign-in" />
      <form onSubmit={save}>

      <Card title="Electricity (PLN)" icon={PlugZap}>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="tariff" label="Tariff group">
            <select
              id="tariff"
              className={input}
              value={form.tariff_preset}
              onChange={(e) => {
                const preset = data.tariff_presets[e.target.value];
                setForm({ ...form, tariff_preset: e.target.value, tariff_rp_per_kwh: preset.rate ?? form.tariff_rp_per_kwh });
              }}
            >
              {Object.entries(data.tariff_presets).map(([k, p]) => (
                <option key={k} value={k}>{p.label}{p.rate ? ` · ${rupiahFine(p.rate)}/kWh` : ""}</option>
              ))}
            </select>
          </Field>
          <Field id="rate" label="Rate (Rp per kWh)" hint={form.tariff_preset !== "custom" ? "Pick Custom to type your own rate." : undefined}>
            <input id="rate" type="number" step="0.01" min="0" inputMode="decimal" className={input} value={form.tariff_rp_per_kwh}
              disabled={form.tariff_preset !== "custom"} onChange={(e) => set("tariff_rp_per_kwh", Number(e.target.value))} />
          </Field>
          <Field id="ppj" label="PPJ, street-lighting tax (%)" hint="Differs per region, usually 3–10%. Use 0 if your bill or token has none.">
            <input id="ppj" type="number" step="0.1" min="0" inputMode="decimal" className={input} value={form.ppj_percent}
              onChange={(e) => set("ppj_percent", Number(e.target.value))} />
          </Field>
          <Field id="overhead" label="Platform overhead (W)" hint="Power nothing measures: motherboard, fans, Wi-Fi, adapter loss. Added on top of WattSeal.">
            <input id="overhead" type="number" step="0.5" min="0" inputMode="decimal" className={input} value={form.overhead_watts}
              onChange={(e) => set("overhead_watts", Number(e.target.value))} />
          </Field>
        </div>
        <p className="mt-5 rounded-lg bg-bg px-3 py-2 text-sm text-fg-2">
          Effective rate: <span className="tnum font-mono">{rupiahFine(effective)}</span> per kWh
        </p>
      </Card>

      <Card title="Monitoring" icon={Cog} className="mt-4">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="speedtest" label="Speed test every (hours)" hint="0 turns automatic tests off.">
            <input id="speedtest" type="number" min="0" step="0.5" inputMode="decimal" className={input} value={form.speedtest_interval_hours}
              onChange={(e) => set("speedtest_interval_hours", Number(e.target.value))} />
          </Field>
          <Field id="tz" label="Timezone" hint="Used for hourly, daily, weekly and monthly energy.">
            <input id="tz" className={input} value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
          </Field>
          <Field id="watched" label="Watched services" hint="Comma separated systemd unit names." className="sm:col-span-2">
            <textarea id="watched" rows={3} className={`${input} h-auto py-2 font-mono`} value={services} onChange={(e) => setServices(e.target.value)} />
          </Field>
        </div>
      </Card>

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" variant="primary" icon={state === "saved" ? Check : Save} disabled={state === "saving"}>
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save settings"}
        </Button>
        {!["idle", "saving", "saved"].includes(state) && <span role="alert" className="text-sm text-bad">{state}</span>}
      </div>
      </form>

      <Passkeys />
    </div>
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

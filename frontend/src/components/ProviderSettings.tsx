import { Network, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Provider, ProviderCatalog } from "../provider-types";
import { Button, Card } from "./ui";

const inputClass = "h-11 min-w-0 w-full rounded-lg border border-line-strong bg-bg px-3 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";
type ProviderForm = { id: string | null; name: string; base_url: string; api_key: string; enabled: boolean };
const emptyForm = (): ProviderForm => ({ id: null, name: "", base_url: "", api_key: "", enabled: true });

function providerHost(baseUrl: string) {
  try { return new URL(baseUrl).host; }
  catch { return "Invalid provider URL"; }
}

// Only show the server's human-readable detail, never a raw response or submitted credential.
function safeMessage(message: string, secret = "") {
  let safe = secret ? message.split(secret).join("[redacted]") : message;
  safe = safe.replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
    catch { return "[provider URL]"; }
  });
  return safe.replace(/\b(?:Bearer\s+\S+|sk-[\w-]+|(?:api[_ -]?key|authorization)\s*[:=]\s*\S+)/gi, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 350);
}

async function requestCatalog(path = "/api/providers", init?: RequestInit, secret = ""): Promise<ProviderCatalog> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  if (response.status === 401) window.dispatchEvent(new Event("auth-required"));
  if (!response.ok) {
    let message = `Provider request failed (${response.status}). Try again.`;
    try {
      const data: unknown = await response.json();
      if (data && typeof data === "object" && "detail" in data && typeof data.detail === "string") message = safeMessage(data.detail, secret);
    } catch { /* Raw response bodies can contain credentials. Never render them. */ }
    throw new Error(message);
  }
  const data = await response.json() as ProviderCatalog;
  if (!Array.isArray(data.providers) || !Array.isArray(data.models)) throw new Error("Invalid provider catalog response. Try again.");
  return data;
}

function sameProvider(left: Provider, right: Provider) {
  return left.id === right.id && left.name === right.name && left.base_url === right.base_url && left.enabled === right.enabled
    && left.api_key_configured === right.api_key_configured && left.model_count === right.model_count
    && left.last_refreshed === right.last_refreshed && left.error === right.error;
}

export function ProviderSettings() {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirming) cancelDelete.current?.focus(); }, [confirming]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const focusAddPending = useRef(false);
  useEffect(() => {
    if (!busy && focusAddPending.current && !form && !confirming) {
      focusAddPending.current=false;
      addButton.current?.focus();
    }
  }, [busy, form, confirming]);
  useEffect(() => {
    let active = true;
    requestCatalog().then((value) => { if (active) setCatalog(value); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? safeMessage(cause.message) : "Could not load providers. Try again."); });
    return () => { active = false; };
  }, []);

  const reload = async () => {
    if (busy) return;
    setBusy(true); setActivity("Loading providers…"); setError(null); setNotice("");
    try { setCatalog(await requestCatalog()); }
    catch (cause) { setError(cause instanceof Error ? safeMessage(cause.message) : "Could not load providers. Try again."); }
    finally { setBusy(false); }
  };
  const closeForm = () => { focusAddPending.current=true; setForm(null); };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || busy || !catalog) return;
    let url: URL;
    try { url = new URL(form.base_url.trim()); }
    catch { setError("Enter a valid HTTP or HTTPS API base URL."); document.getElementById("provider-base-url")?.focus(); return; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      setError("Use an HTTP or HTTPS API base URL without credentials, query parameters, or a fragment."); document.getElementById("provider-base-url")?.focus(); return;
    }
    const name = form.name.trim();
    if (!name) { setError("Enter a provider name."); document.getElementById("provider-name")?.focus(); return; }
    setBusy(true); setActivity("Saving provider…"); setError(null); setNotice("");
    const secret = form.api_key;
    try {
      const before = catalog.providers.find((provider) => provider.id === form.id);
      const result = await requestCatalog(form.id ? `/api/providers/${encodeURIComponent(form.id)}` : "/api/providers", {
        method: form.id ? "PUT" : "POST",
        body: JSON.stringify({ name, base_url: form.base_url.trim(), enabled: form.enabled, ...(secret ? { api_key: secret } : {}) }),
      }, secret);
      setForm((current) => current ? { ...current, api_key: "" } : null);
      const target = form.id ? result.providers.find((provider) => provider.id === form.id)
        : result.providers.find((provider) => !catalog.providers.some((old) => old.id === provider.id));
      const readback = await requestCatalog();
      const actual = target && readback.providers.find((provider) => provider.id === target.id);
      const expectedUrl = form.base_url.trim().replace(/\/+$/, "");
      // GET may discover a new snapshot; verify the saved configuration, not volatile model counts.
      if (!target || !actual || target.id !== actual.id || actual.name !== name || actual.base_url.replace(/\/+$/, "") !== expectedUrl
        || actual.enabled !== form.enabled || (secret && !actual.api_key_configured)
        || (!secret && before && actual.api_key_configured !== before.api_key_configured)) {
        throw new Error("The provider write could not be verified. Reload providers before trying again.");
      }
      setCatalog(readback);
      closeForm();
      setNotice("Provider saved. Refresh models to discover available models.");
      window.dispatchEvent(new Event("providers-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? safeMessage(cause.message, secret) : "Could not save provider. Try again.");
    } finally { setBusy(false); }
  };

  const refresh = async (id?: string) => {
    if (busy || !catalog) return;
    if (id && !catalog.providers.find((p)=>p.id===id)?.enabled) return;
    setBusy(true); setActivity("Refreshing models…"); setError(null); setNotice("");
    try {
      const result = await requestCatalog(id ? `/api/providers/${encodeURIComponent(id)}/refresh` : "/api/providers/refresh", { method: "POST" });
      const readback = await requestCatalog();
      const targets = result.providers.filter((provider) => provider.enabled && (!id || provider.id === id));
      const targetIds = new Set(targets.map((p)=>p.id));
      if ((id && targets.length !== 1) || targets.some((target) => {
        const actual = readback.providers.find((provider) => provider.id === target.id);
        return !actual || !sameProvider(target, actual);
      }) || result.models.filter((model)=>targetIds.has(model.provider_id)).some((model) => !readback.models.some((actual) => model.id === actual.id && model.provider_id === actual.provider_id))) {
        throw new Error("The refreshed catalog could not be verified. Reload providers before trying again.");
      }
      setCatalog(readback);
      const failed = targets.filter((provider) => provider.error).length;
      setNotice(`Model refresh complete: ${targets.length - failed} refreshed, ${failed} failed. ${readback.models.length} models available.`);
      window.dispatchEvent(new Event("providers-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? safeMessage(cause.message) : "Could not refresh models. Try again.");
    } finally { setBusy(false); }
  };

  const dismissDelete = () => { setConfirming(null); deleteTrigger.current?.focus(); };
  const remove = async (id: string) => {
    if (busy || confirming !== id) return;
    setBusy(true); setActivity("Removing provider…"); setError(null); setNotice("");
    try {
      await requestCatalog(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      const readback = await requestCatalog();
      if (readback.providers.some((provider) => provider.id === id) || readback.models.some((model) => model.provider_id === id)) {
        throw new Error("The provider removal could not be verified. Reload providers before trying again.");
      }
      setCatalog(readback); setConfirming(null);
      if (form?.id === id) closeForm();
      focusAddPending.current=true;
      setNotice("Provider removed.");
      window.dispatchEvent(new Event("providers-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? safeMessage(cause.message) : "Could not remove provider. Try again.");
    } finally { setBusy(false); }
  };

  return (
    <Card title="AI Providers" icon={Network} className="mb-4 min-w-0 [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:touch-manipulation" actions={
      <button ref={addButton} type="button" aria-expanded={form?.id === null} aria-controls="provider-editor" disabled={busy || !catalog}
        onClick={() => { setForm(emptyForm()); setError(null); setNotice(""); }}
        className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-bg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
        <Plus size={16} aria-hidden />Add provider
      </button>
    }>
      <p className="text-sm text-muted">Configure the endpoints available to Claude Code. Claude Code requires Anthropic messages compatibility; discovery via <code className="font-mono">/models</code> does not guarantee a model can run.</p>
      {error && <div className="mt-3 space-y-2"><p role="alert" className="text-sm text-bad [overflow-wrap:anywhere]">{error}</p><Button disabled={busy} onClick={() => void reload()}>Reload providers</Button></div>}
      <p role="status" aria-live="polite" className="mt-3 text-sm text-good [overflow-wrap:anywhere]">{busy ? activity : notice}</p>
      {catalog && <div className="mt-4 flex flex-wrap gap-2"><Button icon={RefreshCw} onClick={() => void refresh()} disabled={busy || !catalog.providers.some((p)=>p.enabled)}>Refresh all models</Button></div>}
      {!catalog && !error && <p role="status" className="mt-4 text-sm text-muted">Loading providers…</p>}
      {form && (
        <form id="provider-editor" aria-label={form.id ? "Edit provider" : "Add provider"} onSubmit={save} className="mt-4 min-w-0 rounded-lg border border-line-strong p-4"
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); closeForm(); } }}>
          <h3 className="mb-4 text-sm font-medium">{form.id ? "Edit provider" : "Add provider"}</h3>
          <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="provider-name" className="mb-1.5 block text-sm text-fg-2">Name</label>
              <input id="provider-name" name="provider-name" autoFocus required maxLength={100} autoComplete="off" className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="min-w-0">
              <label htmlFor="provider-base-url" className="mb-1.5 block text-sm text-fg-2">API base URL</label>
              <input id="provider-base-url" name="provider-base-url" required type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://provider.example/v1" className={inputClass} value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label htmlFor="provider-api-key" className="mb-1.5 block text-sm text-fg-2">API key <span className="text-muted">(optional)</span></label>
              <input id="provider-api-key" name="provider-api-key" type="password" autoComplete="new-password" spellCheck={false} aria-describedby="provider-key-hint" placeholder={form.id ? "Leave blank to keep existing key unchanged" : "Optional for no-auth providers"} className={inputClass} value={form.api_key} onChange={(event) => setForm({ ...form, api_key: event.target.value })} />
              <p id="provider-key-hint" className="mt-1.5 text-xs text-muted">{form.id ? "Saved keys are never displayed. Leave blank to keep the existing key unchanged." : "Leave blank for a provider that does not require authentication."} Keys are sent only to the server when you save, never stored in this browser.</p>
            </div>
            <label htmlFor="provider-enabled" className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg-2 sm:col-span-2">
              <input id="provider-enabled" name="provider-enabled" type="checkbox" className="size-5 accent-accent" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Enabled · available in the model picker
            </label>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" variant="primary" icon={Save} disabled={busy}>{busy ? "Saving…" : "Save provider"}</Button>
              <Button onClick={closeForm} disabled={busy}>Cancel</Button>
            </div>
          </fieldset>
        </form>
      )}
      {catalog?.providers.length === 0 && <p className="mt-4 text-sm text-muted">No providers configured. Add a provider to discover models.</p>}
      <div className="mt-4 space-y-3">
        {catalog?.providers.map((provider) => (
          <article key={provider.id} data-provider-id={provider.id} aria-label={provider.name} className="min-w-0 rounded-lg border border-line-strong bg-bg p-4 [overflow-wrap:anywhere]">
            <h3 className="text-sm font-medium">{provider.name}</h3>
            <p className="mt-1 font-mono text-xs text-fg-2">{providerHost(provider.base_url)}</p>
            <p className="mt-2 text-xs text-muted">{provider.enabled ? "Enabled" : "Disabled"} · {provider.api_key_configured ? "API key configured" : "No API key configured"} · {provider.model_count} {provider.model_count === 1 ? "model" : "models"}</p>
            <p className="mt-1 text-xs text-muted">Last refreshed: {provider.last_refreshed == null ? "Never" : new Date(provider.last_refreshed * 1000).toLocaleString()}</p>
            {provider.error && <p role="alert" className="mt-2 text-sm text-bad">{safeMessage(provider.error)}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => { setForm({ id: provider.id, name: provider.name, base_url: provider.base_url, api_key: "", enabled: provider.enabled }); setError(null); setNotice(""); }}>Edit</Button>
              <Button disabled={busy || !provider.enabled} icon={RefreshCw} onClick={() => void refresh(provider.id)}>Refresh</Button>
              <button type="button" disabled={busy} aria-expanded={confirming === provider.id}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 text-sm text-bad hover:bg-bad/10 disabled:opacity-50"
                onClick={(event) => { deleteTrigger.current = event.currentTarget; setConfirming(provider.id); setError(null); setNotice(""); }}>
                <Trash2 size={16} aria-hidden />Delete
              </button>
            </div>
            {confirming === provider.id && <div role="group" aria-label={`Delete ${provider.name}?`} className="mt-3 rounded-lg border border-bad/40 p-3"
              onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); dismissDelete(); } }}>
              <p className="text-sm text-fg-2">Delete {provider.name}? This removes its saved configuration and models from the picker. Existing conversations are kept.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button ref={cancelDelete} type="button" disabled={busy} onClick={dismissDelete} className="cursor-pointer rounded-lg border border-line-strong bg-surface-2 px-4 text-sm disabled:opacity-50">Cancel</button>
                <button type="button" disabled={busy} onClick={() => void remove(provider.id)} className="cursor-pointer rounded-lg bg-bad px-4 text-sm font-medium text-bg disabled:opacity-50">Confirm delete</button>
              </div>
            </div>}
          </article>
        ))}
      </div>
    </Card>
  );
}

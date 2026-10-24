import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import type { ProviderCatalog } from "../src/provider-types";
import "../src/index.css";

// Every /api request is intercepted. No fixture request reaches a live backend.
const fixture: ProviderCatalog = {
  providers: [{ id: "fixture-router", name: "Fixture Router", base_url: "https://router.example.test:9443/v1", enabled: true, api_key_configured: true, model_count: 1, last_refreshed: 1700000000, error: null }],
  models: [{ id: "fixture-model", name: "Fixture model", provider: "Fixture Router", provider_id: "fixture-router" }],
};
let catalog = structuredClone(fixture);
const requests: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
const results: { name: string; passed: boolean; error?: string }[] = [];
const errors: string[] = [];
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); originalConsoleError(...args); };
console.warn = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); originalConsoleWarn(...args); };
let events = 0;
let failRefresh = false;
let partialRefresh = false;
let staleWriteReadback = false;
let snapshotBeforeWrite: ProviderCatalog | null = null;
let failLoad = false;
let rejectWrite = false;
let discoverNextReadback = false;
let changeOtherOnReadback = false;
let refreshOther = false;
window.addEventListener("providers-updated", () => events++);
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
window.fetch = async (input, init) => {
  const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
  requests.push({ path, method, body });
  if (path === "/api/settings" && method === "GET") return Response.json({ settings: { tariff_preset: "custom", tariff_rp_per_kwh: 1000, ppj_percent: 0, overhead_watts: 5, timezone: "Asia/Jakarta", speedtest_interval_hours: 0, watched_services: [] }, tariff_presets: { custom: { label: "Custom", rate: null } } });
  if (path === "/api/passkeys") return Response.json([{ id: "fixture-passkey", name: "Fixture device", synced: true, created: 1700000000, last_used: null }]);
  if (path === "/api/auth/status") return Response.json({ origin: "https://monitor.example.test" });
  if (path === "/api/providers" && method === "GET") {
    if (failLoad) return Response.json({ detail: "Provider catalog unavailable" }, { status: 503 });
    if (changeOtherOnReadback) {
      changeOtherOnReadback=false;
      catalog.models=catalog.models.map((m)=>m.provider_id==="fixture-added" ? {...m,id:"changed-unrelated-model"} : m);
    }
    if (discoverNextReadback) {
      discoverNextReadback = false;
      const p = catalog.providers[0];
      p.model_count += 1; p.last_refreshed = 1700000999;
      catalog.models.push({id:"auto-discovered",name:"Auto discovered",provider:p.name,provider_id:p.id});
    }
    return Response.json(structuredClone(staleWriteReadback && snapshotBeforeWrite ? snapshotBeforeWrite : catalog));
  }
  if (rejectWrite && method === "PUT") return Response.json({ detail: `Invalid credential ${body?.api_key}. Check provider access.` }, { status: 400 });
  if ((path === "/api/providers/refresh" || path.endsWith("/refresh")) && method === "POST") {
    if (failRefresh) return Response.json({ detail: "Discovery endpoint unavailable. Try later." }, { status: 502 });
    const targets = path === "/api/providers/refresh" ? catalog.providers.filter((provider) => provider.enabled) : catalog.providers.filter((provider) => provider.enabled && path === `/api/providers/${provider.id}/refresh`);
    for (const provider of targets) {
      provider.last_refreshed = 1700000060;
      provider.error = partialRefresh && provider.id === "fixture-added" ? "Discovery temporarily unavailable" : null;
      if (!provider.error) {
        const id = `${provider.id}-discovered-model`;
        if (!catalog.models.some((model) => model.id === id)) catalog.models.push({ id, name: "Newly discovered fixture model", provider: provider.name, provider_id: provider.id });
        provider.model_count = catalog.models.filter((model) => model.provider_id === provider.id).length;
      }
    }
    if (refreshOther) changeOtherOnReadback=true;
    return Response.json(structuredClone(catalog));
  }
  if (path === "/api/providers/fixture-added" && method === "DELETE") {
    catalog.providers = catalog.providers.filter((provider) => provider.id !== "fixture-added");
    catalog.models = catalog.models.filter((model) => model.provider_id !== "fixture-added");
    return Response.json(structuredClone(catalog));
  }
  if (path === "/api/providers" && method === "POST" && body) {
    catalog.providers.push({ id: "fixture-added", name: String(body.name), base_url: String(body.base_url), enabled: body.enabled === true, api_key_configured: Boolean(body.api_key), model_count: 0, last_refreshed: null, error: null });
    return Response.json(structuredClone(catalog));
  }
  if (path === "/api/providers/fixture-router" && method === "PUT" && body) {
    const provider = catalog.providers[0];
    Object.assign(provider, { name: String(body.name), base_url: String(body.base_url), enabled: body.enabled === true, api_key_configured: body.api_key ? true : provider.api_key_configured });
    return Response.json(structuredClone(catalog));
  }
  return Response.json({ detail: "Unexpected fixture request" }, { status: 500 });
};
const root = createRoot(document.getElementById("provider-root")!);
const report = document.getElementById("test-results")!;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function waitFor(check: () => unknown, message: string) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
const text = () => document.getElementById("provider-root")!.textContent ?? "";
function button(label: string, container: ParentNode = document) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  assert(element, `Missing button: ${label}`);
  return element;
}
async function click(label: string, container: ParentNode = document) {
  button(label, container).click();
  await new Promise((resolve) => setTimeout(resolve, 25));
}
function fill(id: string, value: string) {
  const element = document.getElementById(id) as HTMLInputElement;
  assert(element, `Missing input: ${id}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
function card(id = "fixture-router") {
  const element = document.querySelector<HTMLElement>(`article[data-provider-id="${id}"]`);
  assert(element, `Missing provider card: ${id}`);
  return element;
}
async function settleForm() { await new Promise((resolve) => setTimeout(resolve, 25)); }
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  report.textContent = results.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.name}${r.error ? `: ${r.error}` : ""}`).join("\n");
}
Object.assign(window, { providerSettingsTests: { results, requests, errors, get events() { return events; }, get catalog() { return catalog; }, complete: false } });
async function run() {
  await test("renders real provider manager with safe host and credential status", async () => {
    const modules = import.meta.glob<{ ProviderSettings: ComponentType }>("../src/components/ProviderSettings.tsx");
    const load = modules["../src/components/ProviderSettings.tsx"];
    assert(load, "ProviderSettings component is not implemented");
    const { ProviderSettings } = await load();
    root.render(<ProviderSettings />);
    await waitFor(() => text().includes("Fixture Router"), "Provider fixture did not render");
    assert(text().includes("router.example.test:9443"), "Exact provider host is missing");
    assert(text().includes("API key configured"), "Configured key status is missing");
    assert(text().includes("1 model"), "Model count is missing");
    assert(text().includes("Anthropic") && text().includes("/models"), "Compatibility limitation is missing");
    assert(!document.querySelector('input[type="password"]'), "Saved credential should not be revealed");
    assert(errors.length === 0, `Browser errors: ${errors.join(", ")}`);
  });
  await test("creates a no-auth provider with explicit enabled and verified readback", async () => {
    const before = events;
    await click("Add provider");
    assert(document.activeElement?.id === "provider-name", "Add form should focus its name");
    fill("provider-name", "Local Fixture");
    fill("provider-base-url", "http://localhost:4312/v1");
    await settleForm();
    assert((document.getElementById("provider-api-key") as HTMLInputElement).type === "password", "Credential must be a password input");
    await click("Save provider");
    await waitFor(() => text().includes("Provider saved"), "Create did not succeed");
    const write = requests.findIndex((item) => item.method === "POST" && item.path === "/api/providers");
    assert(write >= 0 && requests[write].body?.enabled === true, "Create must explicitly send enabled=true");
    assert(!requests[write].body?.api_key, "Blank API key should support no-auth");
    assert(requests[write + 1]?.method === "GET" && requests[write + 1].path === "/api/providers", "Create must read back catalog");
    assert(card("fixture-added").textContent?.includes("No API key configured"), "No-auth status missing");
    assert(events === before + 1, "Create must notify the model picker after verification");
    assert(document.activeElement === button("Add provider"), "Successful save must restore focus after controls re-enable");
  });
  await test("edits with a blank API key preserving the existing key", async () => {
    await click("Edit", card());
    assert((document.getElementById("provider-api-key") as HTMLInputElement).value === "", "Saved key must never fill the input");
    assert((document.getElementById("provider-api-key") as HTMLInputElement).placeholder.includes("unchanged"), "Blank-key preservation should be clear");
    fill("provider-name", "Fixture Router Edited");
    const enabled = document.getElementById("provider-enabled") as HTMLInputElement;
    enabled.click();
    await settleForm();
    await click("Save provider");
    await waitFor(() => card().textContent?.includes("Fixture Router Edited"), "Edit did not update the card");
    const write = requests.findIndex((item) => item.method === "PUT");
    assert(write >= 0 && !requests[write].body?.api_key, "Blank edit must not replace the saved key");
    assert(requests[write].body?.enabled === false, "Disabled state must be explicit");
    assert(requests[write + 1]?.method === "GET", "Edit must read back catalog");
    assert(card().textContent?.includes("API key configured"), "Existing key was lost");
    assert(card().textContent?.includes("Disabled"), "Enabled state did not update");
    assert(button("Refresh",card()).disabled,"Disabled provider must not offer a successful refresh");
  });
  await test("refreshes one provider and verifies newly discovered model count", async () => {
    await click("Edit",card());
    (document.getElementById("provider-enabled") as HTMLInputElement).click();
    await settleForm(); await click("Save provider"); await waitFor(()=>!document.querySelector("#provider-editor"),"Re-enable did not finish");
    const before = requests.length;
    await click("Refresh", card());
    await waitFor(() => card().textContent?.includes("2 models"), "Individual refresh did not update model count");
    assert(requests[before]?.path === "/api/providers/fixture-router/refresh", "Individual refresh used wrong endpoint");
    assert(requests[before + 1]?.method === "GET", "Refresh must read back catalog");
    assert(text().includes("1 refreshed") && text().includes("0 failed"), "Refresh summary is missing counts");
  });
  await test("preserves provider list and displays server error when global refresh fails", async () => {
    const before = events;
    failRefresh = true;
    await click("Refresh all models");
    await waitFor(() => text().includes("Discovery endpoint unavailable"), "Refresh error not displayed");
    assert(card().textContent?.includes("2 models"), "Refresh failure discarded the existing model list");
    assert(events === before, "Failed refresh must not publish an update");
    failRefresh = false;
  });
  await test("global refresh summarizes partial failures and preserves usable models", async () => {
    partialRefresh = true;
    await click("Refresh all models");
    await waitFor(() => text().includes("1 refreshed") && text().includes("1 failed"), "Partial refresh counts are missing");
    assert(card("fixture-added").textContent?.includes("Discovery temporarily unavailable"), "Provider refresh error is missing");
    assert(card().textContent?.includes("2 models"), "Partial failure discarded usable models");
    partialRefresh = false;
  });
  await test("individual refresh ignores unrelated provider snapshot changes", async () => {
    catalog.models.push({id:"old-unrelated-model",name:"Other old",provider:"Local Fixture",provider_id:"fixture-added"});
    refreshOther=true;
    const before=events;
    await click("Refresh",card());
    await waitFor(()=>text().includes("1 refreshed")&&text().includes("0 failed"),"Unrelated provider changed; selected provider refresh must still verify");
    assert(events===before+1,"Verified single refresh should notify picker");
    refreshOther=false;
  });
  await test("requires explicit delete confirmation and cancel keeps the provider", async () => {
    const before = requests.length;
    await click("Delete", card("fixture-added"));
    assert(card("fixture-added").textContent?.includes("Delete Local Fixture?"), "Delete confirmation must name the provider");
    assert(!requests.slice(before).some((request) => request.method === "DELETE"), "Delete must not happen before confirmation");
    await click("Cancel", card("fixture-added"));
    assert(!card("fixture-added").textContent?.includes("Confirm delete"), "Cancel should close confirmation");
    assert(!requests.slice(before).some((request) => request.method === "DELETE"), "Cancel must not delete");
  });
  await test("deletes provider only after confirmation and verifies exact removal", async () => {
    const before = requests.length;
    const beforeEvents = events;
    await click("Delete", card("fixture-added"));
    await click("Confirm delete", card("fixture-added"));
    await waitFor(() => !document.querySelector('[data-provider-id="fixture-added"]'), "Deleted provider remains visible");
    assert(requests[before]?.path === "/api/providers/fixture-added" && requests[before].method === "DELETE", "Delete used wrong provider");
    assert(requests[before + 1]?.method === "GET", "Delete must verify with catalog readback");
    assert(text().includes("Provider removed"), "Removal success missing");
    assert(events === beforeEvents + 1, "Verified removal must notify model picker");
    assert(document.activeElement===button("Add provider"),"Successful delete must restore focus after controls re-enable");
  });
  await test("does not claim saved or notify when the exact target readback disagrees", async () => {
    snapshotBeforeWrite = structuredClone(catalog);
    staleWriteReadback = true;
    const before = events;
    await click("Edit", card());
    fill("provider-name", "Unverified Fixture");
    await settleForm();
    await click("Save provider");
    await waitFor(() => text().includes("could not be verified"), "Mismatched readback should fail verification");
    assert(!text().includes("Provider saved"), "Unverified write must not claim saved");
    assert(events === before, "Unverified write must not notify picker");
    assert(card().textContent?.includes("Fixture Router Edited"), "Unverified write must preserve displayed provider");
    staleWriteReadback = false;
    catalog = structuredClone(snapshotBeforeWrite);
    snapshotBeforeWrite = null;
    await click("Cancel", document.getElementById("provider-editor")!);
  });
  await test("redacts fixture credentials from API errors without browser storage", async () => {
    await click("Edit", card());
    const syntheticCredential = "fixture-not-a-real-key";
    fill("provider-api-key", syntheticCredential);
    await settleForm();
    rejectWrite = true;
    await click("Save provider");
    await waitFor(() => text().includes("Invalid credential"), "Server detail missing");
    assert(!text().includes(syntheticCredential), "Credential leaked in error text");
    assert(text().includes("[redacted]"), "Credential should be redacted");
    assert(!JSON.stringify(localStorage).includes(syntheticCredential) && !JSON.stringify(sessionStorage).includes(syntheticCredential), "Credential must not enter browser storage");
    rejectWrite = false;
    await click("Cancel", document.getElementById("provider-editor")!);
  });
  await test("Escape closes editor and returns focus without submitting", async () => {
    const before = requests.length;
    await click("Add provider");
    const element = document.getElementById("provider-name")!;
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settleForm();
    assert(!document.getElementById("provider-editor"), "Escape should close editor");
    assert(document.activeElement === button("Add provider"), "Escape should return focus to Add provider");
    assert(requests.length === before, "Escape should not submit a request");
  });
  await test("refresh loading state disables controls until verified readback", async () => {
    const originalFetch = window.fetch;
    let release!: () => void;
    window.fetch = async (input, init) => {
      if (typeof input === "string" && input.endsWith("/refresh")) await new Promise<void>((resolve) => { release = resolve; });
      return originalFetch(input, init);
    };
    try {
      button("Refresh all models").click();
      await waitFor(() => text().includes("Refreshing models…"), "Refresh loading status is missing");
      assert(button("Add provider").disabled && button("Refresh all models").disabled, "Refresh should lock conflicting actions");
      release();
      await waitFor(() => !button("Refresh all models").disabled, "Refresh never completed");
    } finally { window.fetch = originalFetch; }
  });
  await test("empty provider catalog explains how to add a provider", async () => {
    root.render(<></>);
    await settleForm();
    const previous = catalog;
    catalog = { providers: [], models: [] };
    const { ProviderSettings } = await import("../src/components/ProviderSettings");
    root.render(<ProviderSettings />);
    await waitFor(() => text().includes("No providers configured"), "Empty state missing");
    assert(!button("Add provider").disabled, "Empty catalog must allow adding a provider");
    assert(button("Refresh all models").disabled, "Empty catalog should not refresh");
    catalog = previous;
  });
  await test("failed initial catalog load can be retried without page reload", async () => {
    root.render(<></>);
    await settleForm();
    failLoad = true;
    const { ProviderSettings } = await import("../src/components/ProviderSettings");
    root.render(<ProviderSettings />);
    await waitFor(() => text().includes("Provider catalog unavailable"), "Load failure missing");
    failLoad = false;
    await click("Reload providers");
    await waitFor(() => text().includes("Fixture Router Edited"), "Retry did not restore catalog");
  });
  await test("save succeeds when verification GET discovers new models", async () => {
    await click("Edit", card());
    fill("provider-name", "Fixture Router Verified");
    await settleForm();
    discoverNextReadback = true;
    await click("Save provider");
    await waitFor(() => text().includes("Provider saved"), "Discovery during GET must not invalidate a verified configuration write");
    assert(card().textContent?.includes("Fixture Router Verified"), "Verified name was not applied");
  });
  await test("Settings renders provider manager above electricity as a separate form", async () => {
    catalog.providers[0].name = `Fixture Router ${"long-provider-name-".repeat(8)}`;
    catalog.providers[0].base_url = `https://${"long-host-".repeat(5)}example.test:9443/v1`;
    catalog.providers[0].error = "Discovery unavailable. ".repeat(12);
    const { Settings } = await import("../src/pages/Settings");
    root.render(<Settings />);
    await waitFor(() => text().includes("Electricity (PLN)"), "Settings fixture did not render");
    assert(text().includes("AI Providers"), "Settings page is missing provider manager");
    assert(text().indexOf("AI Providers") < text().indexOf("Electricity (PLN)"), "Providers should be above electricity");
    await waitFor(() => !button("Add provider").disabled, "Provider manager did not finish loading");
    await click("Add provider");
    const providerForm = document.getElementById("provider-editor");
    assert(providerForm && !providerForm.parentElement?.closest("form"), "Provider editor must not be nested in electricity form");
    assert(document.querySelectorAll("#provider-root form").length === 2, "Provider and electricity forms should be independent");
    await click("Cancel", providerForm);
  });
  Object.assign((window as unknown as { providerSettingsTests: object }).providerSettingsTests, { complete: true });
}
void run();

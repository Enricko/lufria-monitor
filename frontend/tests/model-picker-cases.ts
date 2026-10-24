// Deterministic UI-only provider fixtures; no real router credentials or calls.
export const pickerModels = [
  { id: "shared-model", name: "Shared model", provider: "Lufria Router", provider_id: "lufria" },
  { id: "shared-model", name: "Shared model", provider: "Binav Router", provider_id: "binav" },
  { id: "omo/new-model", name: "Newly discovered model", provider: "OMO API HUB", provider_id: "omo" },
];
export const pickerProviders = ["Lufria Router", "Binav Router", "OMO API HUB"].map((name, i) => ({
  id: ["lufria", "binav", "omo"][i], name, base_url: `https://router-${i}.example/v1`, enabled: true,
  api_key_configured: true, model_count: i === 2 ? 1 : 2, last_refreshed: 1234, error: null,
}));
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const click = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
export async function testModelPicker() {
  const results: { name: string; passed: boolean; actual?: unknown }[] = [];
  const check = (name: string, passed: boolean, actual?: unknown) => results.push({name,passed,actual});
  await wait(400);
  check("native model select replaced", !document.querySelector('select[name="agent-model"]'));
  click("Choose model"); await wait();
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="model-picker-title"]');
  check("bounded searchable picker opens", !!dialog() && !!document.querySelector('input[aria-label="Search models"]'));
  check("provider groups shown", !!dialog() && ["Lufria Router", "Binav Router", "OMO API HUB"].every((name) => dialog()!.textContent?.includes(name)));
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
  if (search) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(search,"shared-model");
    search.dispatchEvent(new Event("input",{bubbles:true}));
  }
  await wait();
  const variants = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button[data-model-id="shared-model"]') || [])];
  check("duplicate model kept per provider", variants.length === 2, variants.length);
  variants.find((e) => e.dataset.providerId === "binav")?.click(); await wait();
  check("provider pair saved exactly", localStorage.getItem("chat.selected_provider") === "binav" && localStorage.getItem("chat.selected_model") === "shared-model");
  check("selection closes picker", !dialog());
  click("Choose model"); await wait();
  check("selected provider is explicit", !!dialog()?.querySelector('[aria-pressed="true"][data-provider-id="binav"]'));
  const refresh = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") || [])].find((e) => e.textContent?.includes("Refresh models"));
  refresh?.click(); await wait(200);
  const s = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
  if (s) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(s,"just-added");
    s.dispatchEvent(new Event("input",{bubbles:true}));
  }
  await wait();
  check("refresh exposes new model", !!dialog()?.querySelector('[data-model-id="just-added"]'));
  if (s) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(s,"no-model-matches");
    s.dispatchEvent(new Event("input",{bubbles:true}));
  }
  await wait();
  check("search empty state", !!dialog()?.textContent?.includes("No matching models"));
  check("manage providers links to Settings", !!dialog()?.querySelector('a[href="#settings"]'));
  const r=dialog()?.getBoundingClientRect();
  check("picker fits viewport", !!r && r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth,r?.toJSON());
  click("Close model picker");
  await wait();
  check("close restores trigger focus", document.activeElement?.getAttribute("aria-label")==="Choose model");
  const send = async () => {
    const input=document.querySelector<HTMLTextAreaElement>("textarea");
    if (input) { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"Exact provider test");input.dispatchEvent(new Event("input",{bubbles:true})); }
    await wait();
    document.querySelector<HTMLButtonElement>('button[title="Send (Enter)"]')?.click();
    await wait(850);
  };
  await send();
  const sent = () => (window as unknown as {__fixtureSockets:{sent:Record<string,unknown>[]}[]}).__fixtureSockets.flatMap((s)=>s.sent).filter((e)=>e.type==="user");
  check("selected duplicate sends to Binav", sent().at(-1)?.provider_id==="binav" && sent().at(-1)?.model==="shared-model");
  click("Choose model");await wait();
  const swapSearch=document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
  if (swapSearch) {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(swapSearch,"shared-model");swapSearch.dispatchEvent(new Event("input",{bubbles:true}));}
  await wait();
  document.querySelector<HTMLButtonElement>('[data-model-id="shared-model"][data-provider-id="lufria"]')?.click();await wait();
  await send();
  check("same-session provider switch uses Lufria", sent().at(-1)?.provider_id==="lufria" && sent().at(-1)?.model==="shared-model");
  check("provider switch does not reopen second engine", (window as unknown as {__fixtureSockets:{url:string}[]}).__fixtureSockets.length===1);
  for (const rawId of ["default","claude"]) {
    click("Choose model");await wait();
    const q=document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    if(q){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(q,rawId);q.dispatchEvent(new Event("input",{bubbles:true}));}
    await wait();
    document.querySelector<HTMLButtonElement>(`[data-model-id="${rawId}"][data-provider-id="binav"]`)?.click();await wait();
    await send();
    check(`router raw ${rawId} remains provider-qualified`,sent().at(-1)?.model===rawId&&sent().at(-1)?.provider_id==="binav");
  }
  return {passed:results.every((r)=>r.passed),results};
}

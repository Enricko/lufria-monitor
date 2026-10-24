// Browser-only regression fixtures for the real Claude component.
// Requests are released explicitly, never timed against a live backend.
type Payload = Record<string, unknown>;
type SocketRecord = { url: string; sent: Payload[]; ws: { emit(event: Payload): void } };
type Check = { name: string; passed: boolean; actual?: unknown };
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await pause();
  }
  throw new Error(`Timed out: ${label}`);
}
async function settle() { await pause(); await pause(); }
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const sockets = () => (window as unknown as { __fixtureSockets: SocketRecord[] }).__fixtureSockets;
const users = () => sockets().flatMap((socket) => socket.sent).filter((event) => event.type === "user");
const selected = () => ({ model: localStorage.getItem("chat.selected_model"), provider_id: localStorage.getItem("chat.selected_provider") });
async function typeMessage(text = "Provider binding regression") {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
function enter() { document.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
async function chooseProvider(providerId = "binav") {
  button("Choose model")?.click();
  await until(() => !!document.querySelector('[aria-label="Search models"]'), "model picker");
  const search = document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "shared-model");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => !!document.querySelector(`[data-model-id="shared-model"][data-provider-id="${providerId}"]`), "provider option");
  document.querySelector<HTMLButtonElement>(`[data-model-id="shared-model"][data-provider-id="${providerId}"]`)!.click();
  await settle();
}

export function installBindingRaceFixture(scenario: string) {
  const previousFetch = window.fetch;
  const requests: { path: string; released: boolean; resolve: (response: Response) => void }[] = [];
  const prepared = new Map<string, { data: unknown; status: number }[]>();
  const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const agent = { id: "agent-1", title: "Agent project", model: "ag/gemini-3.8-flash", provider_id: "lufria", created_at: 100, updated_at: 200, message_count: 1, size_bytes: 100, project: "/fixture" };
  const detail = (id = agent.id, model = agent.model, provider_id: string | null = agent.provider_id) => ({
    id, title: id, model, provider_id,
    messages: [{ role: "user", text: `${id} canonical history`, ts: 100 }],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, total_cost_usd: 0 },
  });
  localStorage.setItem("chat.selected_model", "shared-model");
  localStorage.setItem("chat.selected_provider", "binav");
  if (scenario === "restore" || scenario === "error" || scenario === "restore-manual") localStorage.setItem("claude.chat.session_id", agent.id);
  window.fetch = (input, init) => {
    const path = String(input);
    if (path !== "/api/claude/sessions" && !path.startsWith("/api/claude/sessions/") && !path.startsWith("/api/router/sessions/")) return previousFetch(input, init);
    return new Promise<Response>((resolve) => {
      const ready = prepared.get(path)?.shift();
      requests.push({ path, released: !!ready, resolve });
      if (ready) resolve(response(ready.data, ready.status));
    });
  };
  const release = (path: string, data: unknown, status = 200) => {
    const request = requests.find((item) => item.path === path && !item.released);
    if (request) { request.released = true; request.resolve(response(data, status)); }
    else { const queue = prepared.get(path) || []; queue.push({ data, status }); prepared.set(path, queue); }
  };
  const results: Check[] = [];
  const check = (name: string, passed: boolean, actual?: unknown) => results.push({ name, passed, actual });
  async function run() {
    try {
      await until(() => sockets().length === 1 && !!document.querySelector("textarea") && requests.length > 0, "component and fixture requests");
      await settle();
      if (scenario === "restore") {
        await typeMessage();
        check("restore blocks Send while canonical detail and list are pending", button("Send message")?.disabled === true);
        enter(); await settle();
        check("Enter before hydration never sends the unrelated global provider", users().length === 0, users());
        check("saved session requests canonical detail without waiting for the list", requests.some((request) => request.path === "/api/claude/sessions/agent-1"), requests.map((request) => request.path));
        release("/api/claude/sessions/agent-1", detail());
        await until(() => document.body.textContent?.includes("agent-1 canonical history") === true, "restored canonical history");
        check("canonical model/provider restored before list response", selected().model === agent.model && selected().provider_id === "lufria", selected());
        release("/api/claude/sessions", [agent]); await settle();
        check("composer unlocks only after canonical binding", button("Send message")?.disabled === false);
        button("Send message")?.click(); await settle();
        check("first resumed turn uses saved binding, not global Binav", users().length === 1 && users()[0].model === agent.model && users()[0].provider_id === "lufria", users());
        check("picker stays disabled while the turn is in flight", button("Choose model")?.disabled === true);
      } else if (scenario === "canonical") {
        release("/api/claude/sessions", [agent]);
        await until(() => !!document.querySelector('[aria-label="Agent project"]'), "agent list");
        document.querySelector<HTMLElement>('[aria-label="Agent project"]')!.click();
        await until(() => requests.some((request) => request.path.endsWith("/agent-1")), "agent detail request");
        release("/api/claude/sessions/agent-1", detail(agent.id, "shared-model", "omo"));
        await until(() => document.body.textContent?.includes("agent-1 canonical history") === true, "canonical detail");
        await settle();
        check("canonical detail pair beats older sidebar pair on session change", selected().model === "shared-model" && selected().provider_id === "omo", selected());
        sockets()[0].ws.emit({ type: "status", state: "idle" });
        await until(() => requests.filter((request) => request.path === "/api/claude/sessions").length === 2, "background list refresh");
        release("/api/claude/sessions", [agent]); await settle();
        check("late stale list refresh cannot replace canonical binding", selected().model === "shared-model" && selected().provider_id === "omo", selected());
        await typeMessage(); button("Send message")?.click(); await settle();
        check("next turn uses canonical detail pair", users().at(-1)?.model === "shared-model" && users().at(-1)?.provider_id === "omo", users());
      } else if (scenario === "error" || scenario === "restore-manual") {
        await until(() => requests.some((request) => request.path.endsWith("/agent-1")), "restored session detail");
        if (scenario === "error") {
          release("/api/claude/sessions/agent-1", { error: "fixture unavailable" }, 503);
          await until(() => !!document.querySelector('[role="alert"]'), "visible detail failure");
          release("/api/claude/sessions", [agent]); await settle();
          await typeMessage(); enter(); await settle();
          check("failed restore cannot send even after sidebar succeeds", users().length === 0 && button("Send message")?.disabled === true, users());
          check("restore failure offers Retry and New chat", document.body.textContent?.includes("Retry session") === true && document.body.textContent?.includes("Start new chat") === true);
          await chooseProvider("lufria");
          check("manual route alone cannot bypass failed history load", button("Send message")?.disabled === true);
          [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Retry session")?.click();
          await until(() => requests.filter((request) => request.path.endsWith("/agent-1")).length === 2, "retry detail request");
          check("Retry remains blocked while canonical detail is pending", button("Send message")?.disabled === true);
          release("/api/claude/sessions/agent-1", detail());
          await until(() => document.body.textContent?.includes("agent-1 canonical history") === true, "retry loads history");
          check("retry preserves same-session manual choice", selected().model === "shared-model" && selected().provider_id === "lufria", selected());
          check("successful retry clears failure and unlocks Send", !document.querySelector('[role="alert"]') && button("Send message")?.disabled === false);
          button("Send message")?.click(); await settle();
          check("recovered session sends only after successful retry", users().length === 1 && users()[0].provider_id === "lufria" && users()[0].model === "shared-model", users());
        } else {
          await chooseProvider("lufria");
          release("/api/claude/sessions/agent-1", detail());
          await until(() => document.body.textContent?.includes("agent-1 canonical history") === true, "restored history with manual choice");
          release("/api/claude/sessions", [agent]); await settle();
          check("initial restore respects pending explicit choice", selected().model === "shared-model" && selected().provider_id === "lufria", selected());
          await typeMessage(); button("Send message")?.click(); await settle();
          check("initial restore sends exact manually selected pair", users().length === 1 && users()[0].provider_id === "lufria" && users()[0].model === "shared-model", users());
        }
      } else if (scenario === "manual" || scenario === "ordering") {
        release("/api/claude/sessions", [agent]);
        await until(() => !!document.querySelector('[aria-label="Agent project"]'), "agent list");
        document.querySelector<HTMLElement>('[aria-label="Agent project"]')!.click();
        await until(() => requests.some((request) => request.path.endsWith("/agent-1")), "pending agent detail");
        if (scenario === "manual") {
          await chooseProvider();
          check("explicit choice is stored while detail is pending", selected().model === "shared-model" && selected().provider_id === "binav", selected());
          await typeMessage(); enter(); await settle();
          check("manual choice does not bypass canonical history hydration", users().length === 0, users());
          release("/api/claude/sessions/agent-1", detail());
          await until(() => document.body.textContent?.includes("agent-1 canonical history") === true, "history hydrates despite manual choice");
          check("late detail preserves manual provider/model", selected().model === "shared-model" && selected().provider_id === "binav", selected());
          button("Send message")?.click(); await settle();
          check("next turn honors choice made after detail request started", users().length === 1 && users()[0].model === "shared-model" && users()[0].provider_id === "binav", users());
        } else {
          document.querySelector<HTMLElement>('[aria-label="Archived conversation"]')!.click();
          await until(() => requests.some((request) => request.path.endsWith("/archive-1")), "pending archive detail");
          release("/api/router/sessions/archive-1", detail("archive-1", "archive-model", null));
          await until(() => document.body.textContent?.includes("archive-1 canonical history") === true, "second session history");
          release("/api/claude/sessions/agent-1", detail()); await settle();
          check("older A detail cannot replace newer B history", document.body.textContent?.includes("archive-1 canonical history") === true && !document.body.textContent?.includes("agent-1 canonical history"));
          check("older A detail cannot unlock the selected archive", document.querySelector<HTMLTextAreaElement>("textarea")?.disabled === true);
          check("obsolete A response never resumes its session", !sockets()[0].sent.some((event) => event.type === "resume" && event.session_id === "agent-1"), sockets()[0].sent);
          button("New chat")?.click(); await settle();
          document.querySelector<HTMLElement>('[aria-label="Agent project"]')!.click();
          await until(() => requests.filter((request) => request.path.endsWith("/agent-1")).length === 2, "second agent request");
          button("New chat")?.click(); await settle();
          release("/api/claude/sessions/agent-1", detail()); await settle();
          check("new chat invalidates pending detail without restoring old history", !localStorage.getItem("claude.chat.session_id") && !document.body.textContent?.includes("agent-1 canonical history"));
        }
      } else throw new Error(`Unknown scenario ${scenario}`);
      check("binding hydration retains one Claude Code socket", sockets().length === 1 && sockets()[0].url.endsWith("/ws/claude"), sockets().map((socket) => socket.url));
    } catch (error) { check("scenario completes", false, String(error)); }
    const report = { scenario, passed: results.every((result) => result.passed), results, requests: requests.map(({ path, released }) => ({ path, released })), sockets: sockets().map(({ url, sent }) => ({ url, sent: structuredClone(sent) })) };
    (window as unknown as { __bindingRaces: unknown }).__bindingRaces = report;
    return report;
  }
  return { run };
}

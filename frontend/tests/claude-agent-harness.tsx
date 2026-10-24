/// <reference types="vite/client" />
// Isolated component tests only. Never loaded by the production entry point.
// API and WebSocket fixtures deliberately avoid auth changes or live model calls.
import React from "react";
import { createRoot } from "react-dom/client";
import { Claude } from "../src/pages/Claude";
import { Shell } from "../src/components/Shell";
import { spacingMessages, measureSpacing } from "./claude-spacing-cases";
import { pickerModels, pickerProviders, testModelPicker } from "./model-picker-cases";
import { installBindingRaceFixture } from "./provider-binding-races";
import { testCommandAndFeedbackLogic } from "./command-feedback-cases";
import "../src/index.css";

const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
(window as unknown as { __errors: string[] }).__errors = errors;
const now = Date.now() / 1000;
const agentSession = { id: "agent-1", title: "Agent project", provider_id:"lufria", provider:"Lufria Router", model: "ag/gemini-3.8-flash", created_at: now - 100, updated_at: now, message_count: 2, size_bytes: 100, project: "/home/lufria" };
const archiveSession = { id: "archive-1", title: "Archived conversation", model: "ag/gemini-3.8-flash", created_at: now - 300, updated_at: now - 200, message_count: 2, total_tokens: 120, total_cost_usd: 0.01 };
const bucket = { sessions: 1, input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 120, cost_usd: 0.01 };
const usage = { summary: { today: bucket, week: bucket, month: bucket, all_time: bucket }, history: [], models: {} };
const params = new URLSearchParams(location.search);
localStorage.clear();
if (params.has("legacy")) {
  localStorage.setItem("chat.engine", "router");
  localStorage.setItem("router.chat.session_id", archiveSession.id);
  localStorage.setItem("router.chat.messages", JSON.stringify([{ id: "old", role: "user", text: "OLD ROUTER CACHE" }]));
}
if (params.has("restore")) {
  localStorage.setItem("claude.chat.session_id", agentSession.id);
  localStorage.setItem("chat.selected_model", "default");
}
if (params.has("spacing")) localStorage.setItem("claude.chat.messages", JSON.stringify(spacingMessages));
const sockets: { url: string; sent: Record<string, unknown>[]; ws: FixtureSocket }[] = [];
let sends = 0;
(window as unknown as {__fixtureSockets:unknown}).__fixtureSockets=sockets;
class FixtureSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  record: (typeof sockets)[number];
  constructor(url: string) {
    this.record = { url, sent: [], ws: this };
    sockets.push(this.record);
    setTimeout(() => this.onopen?.(), 0);
  }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  send(raw: string) {
    const event = JSON.parse(raw);
    this.record.sent.push(event);
    if (event.type !== "user") return;
    sends++;
    if (params.has("binding-race")) return;
    this.emit({ type: "status", state: "thinking" });
    this.emit({ type: "system", subtype: "init", session_id: "new-agent", model: event.model || "claude-default" });
    setTimeout(() => this.emit({ type: "tool_start", id: "tool-1", tool: "Bash", command: "pwd" }), 30);
    setTimeout(() => {
      this.emit({ type: "tool_done", tool: "Bash", command: "pwd", output: "/home/lufria" });
      this.emit({ type: "assistant", message: { content: [{ type: "text", text: "UI fixture response" }] } });
      this.emit({ type: "result" });
      this.emit({ type: "status", state: "idle" });
    }, 600);
  }
  close() { this.readyState = 3; }
}
Object.defineProperty(window, "WebSocket", { value: FixtureSocket });
const reservedModels = [{id:"default",name:"Router default model",provider:"Binav Router",provider_id:"binav"},{id:"claude",name:"Router Claude model",provider:"Binav Router",provider_id:"binav"}];
const catalogModels = params.has("large") ? [...pickerModels, ...Array.from({length:180},(_,i)=>({id:`long-model-${i}`,name:`Model ${i} with a long readable display name`,provider:i%2?"Binav Router":"Lufria Router",provider_id:i%2?"binav":"lufria"}))] : pickerModels;
let pickerRefreshes = 0;
window.fetch = async (url) => {
  const path = String(url);
  let data: unknown = [];
  if (path === "/api/providers/refresh") {
    pickerRefreshes++;
    data = {providers:pickerProviders,models:[...pickerModels,...reservedModels,{id:"just-added",name:"Just added",provider:"OMO API HUB",provider_id:"omo"}]};
  }
  else if (path === "/api/providers") data = {providers:pickerProviders,models:(params.has("picker") || params.has("large") || params.has("binding-race")) ? [...catalogModels,...reservedModels,...(pickerRefreshes ? [{id:"just-added",name:"Just added",provider:"OMO API HUB",provider_id:"omo"}] : [])] : [{id:agentSession.model,name:"Gemini 3.8 Flash",provider:"Lufria Router",provider_id:"lufria"}]};
  else if (path.endsWith("/usage")) data = usage;
  else if (path === "/api/router/models") data = [{ id: agentSession.model, name: "Gemini 3.8 Flash", provider: "Model catalog" }];
  else if (path === "/api/claude/sessions") data = [agentSession];
  else if (path === "/api/router/sessions") data = [archiveSession];
  else if (path.endsWith("/agent-1")) data = { ...agentSession, messages: [{ role: "user", text: "Agent session history" }], usage: { ...bucket, total_cost_usd: 0.01, cache_read_input_tokens: 0 } };
  else if (path.endsWith("/archive-1")) data = { ...archiveSession, messages: [{ role: "user", text: "Archive history is preserved" }], usage: { ...bucket, total_cost_usd: 0.01, cache_read_input_tokens: 0 } };
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
};

const bindingRace = params.get("binding-race");
const bindingFixture = bindingRace ? installBindingRaceFixture(bindingRace) : null;
createRoot(document.getElementById("root")!).render(params.has("shell")
  ? <Shell tab="claude" live={null} connected onLogout={() => {}}><Claude active /></Shell>
  : <Claude active />);
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const button = (title: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.title === title);
const clickText = (text: string) => [...document.querySelectorAll<HTMLElement>("p,button")].find((e) => e.textContent === text)?.click();
const results: { name: string; passed: boolean; detail?: string }[] = [];
const check = (name: string, passed: boolean, detail?: string) => results.push({ name, passed, detail });
async function test() {
  await wait(300);
  check("no provider filter tabs", ![...document.querySelectorAll("button")].some((b) => ["Claude Code", "9Router"].includes(b.textContent?.trim() || "")));
  check("only Claude Code socket", sockets.length === 1 && sockets[0].url.endsWith("/ws/claude"), sockets.map((s) => s.url).join(","));
  check("legacy browser engine not restored", !document.body.innerText.includes("OLD ROUTER CACHE"));
  check("archived history remains listed", document.body.innerText.includes(archiveSession.title));
  if (params.has("restore")) check("page refresh restores active model", localStorage.getItem("chat.selected_model") === agentSession.model);
  clickText(agentSession.title);
  await wait();
  check("agent session restores its model", localStorage.getItem("chat.selected_model") === agentSession.model);
  clickText(archiveSession.title);
  await wait();
  check("archive opens without old engine", document.body.innerText.includes("Archive history is preserved") && sockets.every((s) => !s.url.endsWith("/ws/router")));
  check("archive is read only", !!document.querySelector<HTMLTextAreaElement>("textarea")?.disabled);
  button("New chat")?.click();
  await wait();
  document.querySelector<HTMLButtonElement>('button[aria-label="Choose model"]')?.click();
  await wait();
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
  if (search) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(search,agentSession.model);
    search.dispatchEvent(new Event("input",{bubbles:true}));
  }
  await wait();
  document.querySelector<HTMLButtonElement>(`button[data-model-id="${agentSession.model}"][data-provider-id="lufria"]`)?.click();
  await wait();
  const input = document.querySelector<HTMLTextAreaElement>("textarea");
  if (input) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Component regression test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await wait();
  button("Send (Enter)")?.click();
  await wait(100);
  check("send includes exact provider", sockets.some((s) => s.sent.some((e) => e.type === "user" && e.provider_id === "lufria")));
  check("send uses Claude Code model payload", sockets.some((s) => s.url.endsWith("/ws/claude") && s.sent.some((e) => e.type === "user" && e.model === agentSession.model)));
  check("in-flight composer remains disabled after init", !!document.querySelector<HTMLTextAreaElement>("textarea")?.disabled);
  await wait(700);
  check("tool output stays collapsed", !!document.querySelector("details.tool-call:not([open])"));
  check("streamed response renders", document.body.innerText.includes("UI fixture response"));
  check("one user send", sends === 1);
  check("no provider split copy", !document.body.innerText.includes("9Router"));

  const feedbackTest = testCommandAndFeedbackLogic();
  for (const r of feedbackTest.results) {
    check(`feedback: ${r.name}`, r.passed, r.detail ? JSON.stringify(r.detail) : undefined);
  }

  (window as unknown as { __qa: unknown }).__qa = { results, passed: results.every((r) => r.passed), sockets: sockets.map(({url,sent}) => ({url,sent})) };
}
if (bindingFixture) void bindingFixture.run();
if (params.has("test")) test();
if (params.has("commands")) (window as unknown as { __commands: unknown }).__commands = testCommandAndFeedbackLogic();
if (params.has("picker")) testModelPicker().then((r) => { (window as unknown as {__picker:unknown}).__picker=r; });
if (params.has("spacing")) {
  (window as unknown as { __measureSpacing: unknown }).__measureSpacing = measureSpacing;
  setTimeout(() => { (window as unknown as { __spacing: unknown }).__spacing = measureSpacing(); }, 500);
}

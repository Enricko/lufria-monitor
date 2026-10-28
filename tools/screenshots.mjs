// Regenerates docs/screenshots/* from the real production build with every /api and /ws answer faked,
// so no data from the machine it runs on ends up in an image.
//
//   cd frontend && npx vite build --outDir /tmp/lm-dist --emptyOutDir
//   (in an empty dir) npm i playwright && npx playwright install chromium-headless-shell
//   DIST=/tmp/lm-dist PW_DIR=<dir with node_modules/playwright> node tools/screenshots.mjs [shot,shot,...]
//
// Shots: login, overview, overview-mobile, claude, claude-folder, claude-usage, claude-models, claude-mobile
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(`${process.env.PW_DIR}/`)("playwright");
const DIST = path.resolve(process.env.DIST ?? "frontend/dist");
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/screenshots");
const ORIGIN = "http://monitor.example";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff" };
const now = () => Math.floor(Date.now() / 1000);
const day = 86400;

// ---------------------------------------------------------------- fake data
const rnd = (seed) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

function liveSnapshot(i, r) {
  const wave = (a, b, p) => a + (b - a) * (0.5 + 0.5 * Math.sin(i / p));
  const cpu = wave(6, 24, 9) + r() * 4;
  return {
    ts: now() - (120 - i),
    cpu: { percent: cpu, per_core: Array.from({ length: 12 }, () => cpu * (0.5 + r())), freq_mhz: 1800 + r() * 900, load: [0.9 + r(), 0.8, 0.7] },
    mem: { total: 16e9, used: 5.1e9, percent: 33 + r(), cached: 4e9, buffers: 2e8 },
    swap: { total: 4e9, used: 1e8, percent: 2 },
    temps: { cpu: 47 + r() * 3, gpu: null, nvme: 38, pch: 52, acpi: 45, cores: [46, 47, 46, 48, 47, 46],
      all: [{ chip: "coretemp", label: "Package id 0", current: 48, high: 100, critical: 100 }] },
    fans: [{ chip: "asus", label: "cpu_fan", rpm: 2300 }, { chip: "asus", label: "gpu_fan", rpm: 0 }],
    net: { rx: 18000 + r() * 9000, tx: 6000 + r() * 4000, per_nic: { eth0: { rx: 18000, tx: 6000 } } },
    disk: { r: r() * 40000, w: r() * 90000, per_disk: {} },
    uptime: 3 * day + 5 * 3600,
    profile: "balanced",
    power: { source: "wattseal", total: 21 + r() * 3,
      components: { cpu: 4.1, ram: 5.0, gpu: 0, disk: 3.3, net: 0.4, overhead: 8 },
      rapl: { package: 4.1 }, apps: [{ name: "node", w: 1.2, cpu: 3, mem: 2, procs: 4 }],
      wattseal: { ok: true, error: null, raw_total: 20, raw_disk: 3, raw_net: 0.4, cpu_usage: cpu },
      battery: null },
    gpu: { nvidia: { present: true, name: "NVIDIA GeForce GTX 1660 Ti Mobile", driver: "nvidia", state: "suspended", power_state: "D3cold", power_w: 0, metrics: null, procs: [] },
      intel: { name: "Intel UHD Graphics 630", freq_mhz: 350, max_mhz: 1150, min_mhz: 350, busy: 2 } },
  };
}

const specs = { hostname: "home-server", vendor: "ASUSTeK COMPUTER INC.", product: "ROG Strix G731GU", bios: "G731GU.307", os: "Ubuntu 26.04 LTS", kernel: "7.0.0-generic", arch: "x86_64",
  cpu: { model: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz", cores: 6, threads: 12, max_mhz: 4500 }, memory_total: 16e9, swap_total: 4e9,
  gpus: ["Intel CoffeeLake-H GT2 [UHD Graphics 630]", "NVIDIA TU116M [GeForce GTX 1660 Ti Mobile]"], gpu_drivers: ["i915", "nvidia"],
  disks: [{ name: "sda", size: 932e9, model: "Example HDD 1TB", rotational: true, transport: "sata" }, { name: "nvme0n1", size: 238e9, model: "Example NVMe 256GB", rotational: false, transport: "nvme" }],
  nics: [{ name: "eth0", ipv4: ["10.0.0.12"], up: true, speed_mbps: 1000 }] };
const totals = (kwh, cost, w, h) => ({ kwh, cost, avg_w: w, hours: h });
const powerSummary = { totals: { this_hour: totals(0.022, 36, 22, 1), today: totals(0.42, 680, 21.4, 19), this_week: totals(2.9, 4700, 21, 134), this_month: totals(9.1, 14700, 21.2, 430), all_time: totals(31, 50000, 21, 1400) },
  projection: { avg_w: 21.4, kwh_day: 0.51, kwh_month: 15.4, kwh_year: 187, cost_day: 830, cost_month: 24900, cost_year: 303000 }, rate: 1620, tariff_rp_per_kwh: 1444.7, ppj_percent: 0, timezone: "Asia/Jakarta" };
const services = { systemd: { watched: ["ssh", "docker", "cloudflared", "wattseal", "lufria-monitor"].map((u) => ({ unit: u, active: "active", load: "loaded" })), failed: [] },
  docker: { available: true, containers: [{ state: "running" }, { state: "running" }, { state: "running" }] },
  tunnel: { routes: [{ hostname: "monitor.example", up: true }, { hostname: "files.example", up: true }, { hostname: "git.example", up: true }] } };

const t0 = now() - 13 * day;
const usageHistory = Array.from({ length: 14 }, (_, i) => { const x = rnd(i + 3)(); return { date: new Date((t0 + i * day) * 1000).toISOString().slice(0, 10), sessions: 2 + (i % 4), input_tokens: 120000 + x * 90000, output_tokens: 30000 + x * 20000,
  cache_read_tokens: 900000 + x * 500000, cache_creation_tokens: 60000, total_tokens: 1.2e6 + x * 6e5, cost_usd: 0.8 + x * 2.4 }; });
const bucket = (k) => ({ sessions: 4 * k, input_tokens: 210000 * k, output_tokens: 48000 * k, cache_read_tokens: 1.4e6 * k, cache_creation_tokens: 90000 * k, total_tokens: 1.75e6 * k, cost_usd: 1.9 * k });
const usage = { summary: { today: bucket(1), week: bucket(3), month: bucket(7), all_time: bucket(12) }, history: usageHistory,
  models: { "claude-sonnet-5-5": { cost_usd: 21, input_tokens: 2.1e6, output_tokens: 4.8e5 }, "claude-opus-5-5": { cost_usd: 14, input_tokens: 9e5, output_tokens: 2.1e5 } } };

const HOME = "/home/user", CWD = "/home/user/projects/shop-api";
const sessions = [
  { id: "s1", title: "Add rate limiting to the orders endpoint", model: "claude-sonnet-5-5", provider_id: null, created_at: now() - 3600, updated_at: now() - 60, message_count: 14, size_bytes: 52000, project: CWD, cwd: CWD, locked: true, running: false },
  { id: "s2", title: "Fix flaky checkout tests", model: "claude-sonnet-5-5", provider_id: null, created_at: now() - 7200, updated_at: now() - 5400, message_count: 22, size_bytes: 91000, project: CWD, cwd: CWD, locked: true, running: false },
  { id: "s3", title: "Write migration for invoice table", model: "claude-opus-5-5", provider_id: null, created_at: now() - 90000, updated_at: now() - 86000, message_count: 9, size_bytes: 33000, project: `${HOME}/projects/billing`, cwd: `${HOME}/projects/billing`, locked: false, running: false },
  { id: "s4", title: "Explain the deploy script", model: "claude-haiku-5-5", provider_id: null, created_at: now() - 200000, updated_at: now() - 190000, message_count: 4, size_bytes: 9000, project: HOME, running: false },
];
const text = (t) => ({ kind: "text", text: t });
const history = {
  type: "history", session_id: "s1", title: sessions[0].title, model: "claude-sonnet-5-5", provider_id: null, cwd: CWD, locked: true,
  usage: { input_tokens: 48200, output_tokens: 9100, cache_read_input_tokens: 310000, cache_creation_input_tokens: 21000, total_cost_usd: 0.41, estimated: false, unpriced: false, context_tokens: 58000, models: [] },
  messages: [
    { role: "user", parts: [text("Add rate limiting to `POST /orders`: 30 requests per minute per API key, return 429 with a `Retry-After` header. Keep it testable.")] },
    { role: "assistant", model: "claude-sonnet-5-5", parts: [
      { kind: "thinking", text: "I should look at how middleware is registered before choosing where to put the limiter." },
      text("I'll start by reading how the app wires middleware and how the existing tests are set up."),
      { kind: "tool", id: "t1", name: "Read", summary: "src/app.py", output: "from fastapi import FastAPI\nfrom .routes import orders, health\n\napp = FastAPI()\napp.include_router(orders.router)\napp.include_router(health.router)\n", is_error: false, done: true },
      { kind: "tool", id: "t2", name: "TodoWrite", summary: "4 todos", output: "", is_error: false, done: true, todos: [
        { content: "Add a token-bucket limiter keyed by API key", status: "completed" },
        { content: "Wire it into POST /orders and return 429 + Retry-After", status: "completed" },
        { content: "Cover the limiter with unit tests", status: "in_progress" },
        { content: "Document the limit in docs/api.md", status: "pending" }] },
      { kind: "tool", id: "t3", name: "Edit", summary: "src/ratelimit.py", output: "", is_error: false, done: true,
        diff: "  class RateLimiter:\n- def __init__(self):\n-     self.hits = {}\n+ def __init__(self, limit: int = 30, window: float = 60.0, clock=time.monotonic):\n+     self.limit, self.window, self.clock = limit, window, clock\n+     self.hits: dict[str, deque[float]] = defaultdict(deque)\n+\n+ def check(self, key: str) -> float | None:\n+     \"\"\"None when allowed, else seconds until the next request fits.\"\"\"\n+     now = self.clock()\n+     q = self.hits[key]\n+     while q and now - q[0] >= self.window:\n+         q.popleft()\n+     if len(q) >= self.limit:\n+         return self.window - (now - q[0])\n+     q.append(now)\n+     return None" },
      { kind: "tool", id: "t4", name: "Bash", summary: "pytest tests/test_ratelimit.py -q", output: "....................                                  [100%]\n20 passed in 0.41s", is_error: false, done: true },
      text("The limiter is in and the new tests pass. A few notes:\n\n- **Keyed by API key**, falling back to the client IP when the header is missing.\n- Returns `429` with `Retry-After` rounded up to whole seconds.\n- The clock is injectable, so tests don't sleep.\n\nI'm still writing the docs entry; say if you'd rather the limit be configurable per key."),
    ] },
    { role: "user", parts: [text("Looks good. Make the limit configurable through `RATE_LIMIT_PER_MINUTE`.")] },
  ],
};

const caps = { version: "2.1.0", commands: [
  { name: "/help", description: "Show help and available commands", argument_hint: "", aliases: [], builtin: true },
  { name: "/model", description: "Switch model", argument_hint: "[name]", aliases: [], builtin: true },
  { name: "/memory", description: "Edit CLAUDE.md memory files", argument_hint: "", aliases: [], builtin: true },
  { name: "/compact", description: "Summarize the conversation to free context", argument_hint: "", aliases: [], builtin: true },
  { name: "/review", description: "Review a pull request", argument_hint: "[pr]", aliases: [], builtin: false }],
  agents: [{ name: "Explore", description: "Fast read-only code search" }],
  models: [{ value: "default", display_name: "Default", description: "Recommended model", effort_levels: ["low", "medium", "high"] },
    { value: "claude-sonnet-5-5", display_name: "Sonnet 5.5", description: "Fast and capable", effort_levels: ["low", "medium", "high"] },
    { value: "claude-opus-5-5", display_name: "Opus 5.5", description: "Most capable", effort_levels: ["low", "medium", "high", "xhigh"] }],
  output_style: null, output_styles: [], account: { subscription: "max", provider: "firstParty" }, cwd: CWD, home: HOME,
  memory: { project: `${CWD}/CLAUDE.md`, user: `${HOME}/.claude/CLAUDE.md` }, sandbox: { available: true, missing: [] } };
const limits = { available: true, subscription: "max", fetched_at: now() - 20, source: "usage", error: null, windows: [
  { key: "five_hour", label: "5-hour", percent: 42, resets_at: now() + 2 * 3600 + 1500, severity: "normal", active: true },
  { key: "seven_day", label: "Weekly", percent: 18, resets_at: now() + 3 * day, severity: "normal", active: true },
  { key: "seven_day_opus", label: "Weekly Opus", percent: 7, resets_at: now() + 3 * day, severity: "normal", active: true }] };
const providers = { providers: [{ id: "example", name: "Example Router", base_url: "https://router.example/v1", enabled: true, api_key_configured: true, model_count: 2, last_refreshed: now() - 600, error: null }],
  models: [{ id: "model-large", name: "Large model", provider: "Example Router", provider_id: "example" }, { id: "model-fast", name: "Fast model", provider: "Example Router", provider_id: "example" }] };
const folders = { path: `${HOME}/projects`, parent: HOME, home: HOME, writable: true, truncated: false,
  dirs: ["billing", "blog", "dotfiles", "infra", "shop-api", "shop-web"].map((n) => ({ name: n, path: `${HOME}/projects/${n}` })) };
const memory = [{ scope: "project", path: `${CWD}/CLAUDE.md`, exists: true, content: "# shop-api\n\n- FastAPI + Postgres; run tests with `pytest -q`.\n- Never edit files under `migrations/` by hand.\n- Money is stored as integer cents.\n" },
  { scope: "user", path: `${HOME}/.claude/CLAUDE.md`, exists: true, content: "- Prefer small, reviewable commits.\n" }];

const api = (p, authed) => {
  switch (p) {
    case "/api/auth/status": return { enabled: true, authenticated: authed };
    case "/api/specs": return specs;
    case "/api/power/summary": return powerSummary;
    case "/api/services": return services;
    case "/api/claude/sessions": return sessions;
    case "/api/claude/usage": return usage;
    case "/api/router/usage": return { summary: { today: bucket(0), week: bucket(0), month: bucket(0), all_time: bucket(0) }, history: [], models: {} };
    case "/api/claude/capabilities": return caps;
    case "/api/claude/limits": return limits;
    case "/api/providers": return providers;
    case "/api/claude/folders": return folders;
    case "/api/claude/memory": return memory;
    default: return [];
  }
};

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();

async function open({ w, h, scale = 1, hash = "", authed = true, claude = false }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript(([on, cwd]) => {
    try {
      localStorage.clear();
      if (on) { localStorage.setItem("claude.chat.session_id", "s1"); localStorage.setItem("claude.chat.folder", cwd); localStorage.setItem("claude.chat.locked", "1"); localStorage.setItem("chat.selected_model", "claude-sonnet-5-5"); }
    } catch { /* ignore */ }
  }, [claude, CWD]);
  await page.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(api(u.pathname, authed)) });
    let f = path.join(DIST, u.pathname === "/" ? "index.html" : u.pathname);
    if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, "index.html");
    return route.fulfill({ status: 200, contentType: MIME[path.extname(f)] ?? "application/octet-stream", body: fs.readFileSync(f) });
  });
  await page.routeWebSocket(/\/ws\/live/, (ws) => {
    const r = rnd(7);
    for (let i = 0; i <= 120; i++) ws.send(JSON.stringify(liveSnapshot(i, r)));
    let i = 120;
    setInterval(() => ws.send(JSON.stringify(liveSnapshot(++i, r))), 1000);
  });
  await page.routeWebSocket(/\/ws\/claude/, (ws) => {
    ws.onMessage((m) => {
      const e = JSON.parse(String(m));
      if (e.type !== "resume") return;
      if (e.session_id === "s1") { ws.send(JSON.stringify(history)); ws.send(JSON.stringify({ type: "attached", session_id: "s1", running: false })); }
      else ws.send(JSON.stringify({ type: "attached", session_id: null, running: false }));
    });
    ws.send(JSON.stringify({ type: "status", state: "idle", msg: "ready" }));
  });
  await page.goto(`${ORIGIN}/${hash && `#${hash}`}`);
  return { ctx, page };
}

async function shoot(name, opts, act = async () => {}, shot = {}) {
  const { ctx, page } = await open(opts);
  await page.waitForTimeout(1500);
  await act(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, name), ...shot });
  console.log("wrote", name);
  await ctx.close();
}

const wanted = new Set((process.argv[2] ?? "login,overview,overview-mobile,claude,claude-folder,claude-usage,claude-models,claude-mobile").split(","));
const D = { w: 1440, h: 900 };

if (wanted.has("login")) await shoot("login.png", { w: 1440, h: 1000, authed: false });
if (wanted.has("overview")) await shoot("desktop-overview.png", { w: 1440, h: 1000 }, async () => {}, { fullPage: true });
if (wanted.has("overview-mobile")) await shoot("mobile-overview.png", { w: 390, h: 844, scale: 2 }, async () => {}, { fullPage: true });
const expandTools = async (p) => {
  for (const name of ["TodoWrite", "Edit"]) await p.locator("details.tool-call summary", { hasText: name }).first().click();
  await p.evaluate(() => document.activeElement?.blur());
};
if (wanted.has("claude")) await shoot("desktop-claude.png", { ...D, h: 1100, hash: "claude", claude: true }, expandTools);
if (wanted.has("claude-folder")) await shoot("desktop-claude-folder.png", { ...D, hash: "claude", claude: true },
  async (p) => { await p.getByRole("button", { name: /^Folder .*Change folder/ }).click(); await p.waitForTimeout(500); });
if (wanted.has("claude-usage")) await shoot("desktop-claude-usage.png", { ...D, hash: "claude", claude: true },
  async (p) => { await p.getByRole("button", { name: "Usage history" }).first().click(); });
if (wanted.has("claude-models")) await shoot("desktop-claude-models.png", { ...D, hash: "claude", claude: true },
  async (p) => { await p.getByRole("button", { name: "Choose model" }).click(); });
if (wanted.has("claude-mobile")) await shoot("mobile-claude.png", { w: 390, h: 844, scale: 2, hash: "claude", claude: true }, async (p) => { await p.evaluate(() => document.activeElement?.blur()); });

await browser.close();
process.exit(0); // the fake /ws/live timers would keep node alive

// Synthetic UI fixtures, never command execution or production session data.
export const spacingMessages = [
  { id: "spacing-legacy", role: "assistant", text: "\n\n\n\n> ⚙️ **Bash:** `ls -la /home/lufria/binav-backups`\n\n```text\nbackup-one\nbackup-two\n```\n\n\n" },
  { id: "spacing-empty", role: "assistant", text: "\n\n\n> ⚙️ **Bash:** `ps aux | grep -E 'api_server|simulate|vite' | grep -v grep`\n\n\n" },
  { id: "spacing-current", role: "assistant", text: '\n\n<details class="tool-call">\n<summary class="tool-summary"><span class="tool-chevron">▶</span><span class="tool-tag">Bash</span><code class="tool-cmd">pwd</code></summary>\n<div class="tool-output-wrapper"><pre class="tool-output"><code>/home/lufria</code></pre></div>\n</details>\n\n\n' },
  { id: "spacing-prose", role: "assistant", text: "\n\nDi direktori `/home/lufria`, terdapat **2 project utama:**\n\n\n\n---\n\n\n### Project overview\n\nFirst paragraph.\n\n\n\nSecond paragraph.\n\n" },
  { id: "spacing-code", role: "assistant", text: "```python\nfirst = 1\n\n\n    indented = 2\n```" },
];

export function measureSpacing() {
  const bodies = [...document.querySelectorAll<HTMLElement>(".md-body")];
  const checks: { name: string; passed: boolean; actual?: unknown }[] = [];
  const check = (name: string, passed: boolean, actual?: unknown) => checks.push({ name, passed, actual });
  check("all spacing fixtures rendered", bodies.length === spacingMessages.length, bodies.length);
  const tools = bodies.slice(0, 3);
  check("no blank-line BRs around tool cards", tools.every((e) => [...e.children].every((c) => c.tagName !== "BR")));
  check("no leading or trailing BR in prose", bodies.every((e) => e.firstElementChild?.tagName !== "BR" && e.lastElementChild?.tagName !== "BR"));
  const heights = tools.map((e) => e.parentElement!.getBoundingClientRect().height);
  check("collapsed tool messages at most 60px", heights.every((h) => h <= 60), heights);
  const insets = tools.map((e) => (e.querySelector("summary")?.getBoundingClientRect().top || 0) - e.parentElement!.getBoundingClientRect().top);
  check("tool header top inset at most 8px", insets.every((n) => n <= 8), insets);
  check("tool cards start collapsed", tools.every((e) => !e.querySelector("details")?.open));
  check("markdown separator rendered", !!bodies[3]?.querySelector("hr"));
  const paras = [...(bodies[3]?.querySelectorAll("p") || [])];
  const last = paras.at(-1), previous = paras.at(-2);
  const gap = last && previous ? last.getBoundingClientRect().top - previous.getBoundingClientRect().bottom : 999;
  check("paragraph gaps capped at 12px", gap <= 12, gap);
  check("code blank lines and indentation preserved", bodies[4]?.querySelector("pre code")?.textContent === "first = 1\n\n\n    indented = 2");
  const details = tools[0]?.querySelector("details");
  if (details) details.open = true;
  check("expanded tool output preserved", details?.querySelector("pre code")?.textContent === "backup-one\nbackup-two");
  if (details) details.open = false;
  const empty = tools[1]?.querySelector("details");
  if (empty) empty.open = true;
  check("empty tool has explicit compact message", !!empty?.querySelector(".tool-empty-output"));
  if (empty) empty.open = false;
  return { passed: checks.every((c) => c.passed), checks, errors: (window as unknown as { __errors: string[] }).__errors };
}

// Shared formatting for the Claude Code page.

export function formatRelative(ts: number): string {
  const now = Date.now() / 1000;
  const diff = ts - now;
  if (diff <= 0) return "soon";
  const h = Math.floor(diff / 3600);
  const d = Math.floor(diff / 86400);
  if (d > 0) return `in ${d}d`;
  if (h > 0) return `in ${h}h`;
  const m = Math.floor(diff / 60);
  return m > 0 ? `in ${m}m` : "soon";
}

export function formatAgo(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  const h = Math.floor(diff / 3600);
  const d = Math.floor(diff / 86400);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

export function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 10) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatModelBadge(m: string): string {
  if (!m || m === "default" || m === "Claude Code") return "Default model";
  let clean = m.includes("/") ? m.split("/").pop()! : m;
  clean = clean.replace(/-flash|-preview|-turbo|-chat|-pro/gi, "");
  return clean
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 18);
}

/** "~/monitor" for a folder under home. */
export function shortPath(path: string | null | undefined, home: string | null | undefined): string {
  if (!path) return "~";
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** "1.8 MB" */
export function formatSize(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

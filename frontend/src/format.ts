export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export const rate = (n: number | null | undefined) => (n == null ? "–" : `${bytes(n)}/s`);

/** Network rates are usually read in bits. */
export function bits(n: number | null | undefined): string {
  if (n == null) return "–";
  const b = n * 8;
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} Gbps`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(2)} Mbps`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(1)} Kbps`;
  return `${b.toFixed(0)} bps`;
}

/** Shorter bit rates for axis ticks. */
export function bitsAxis(n: number): string {
  const b = n * 8;
  if (b >= 1e9) return `${+(b / 1e9).toFixed(1)} Gbps`;
  if (b >= 1e6) return `${+(b / 1e6).toFixed(1)} Mbps`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} Kbps`;
  return `${Math.round(b)} bps`;
}

export const pct = (n: number | null | undefined) => (n == null ? "–" : `${n.toFixed(1)}%`);
export const temp = (n: number | null | undefined) => (n == null ? "–" : `${n.toFixed(0)}°C`);
export const watts = (n: number | null | undefined, d = 1) => (n == null ? "–" : `${n.toFixed(d)} W`);
export const kwh = (n: number | null | undefined) =>
  n == null ? "–" : n < 1 ? `${(n * 1000).toFixed(n < 0.01 ? 1 : 0)} Wh` : `${n.toFixed(2)} kWh`;

const idr = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const rupiah = (n: number | null | undefined) => (n == null ? "–" : idr.format(n));

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}

const TZ = "Asia/Jakarta";
export const time = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("id-ID", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
export const dateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("id-ID", {
    timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });

export type Severity = "good" | "warn" | "bad";

export function severity(p: number | null | undefined, warn = 70, bad = 90): Severity {
  if (p == null) return "good";
  return p >= bad ? "bad" : p >= warn ? "warn" : "good";
}

/** Compact Rupiah for chart axes: Rp 1,2 rb / Rp 3,4 jt */
export function rupiahShort(n: number): string {
  if (Math.abs(n) >= 1e6) return `Rp ${(n / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`;
  if (Math.abs(n) >= 1e3) return `Rp ${(n / 1e3).toLocaleString("id-ID", { maximumFractionDigits: 1 })} rb`;
  return `Rp ${n.toLocaleString("id-ID", { maximumFractionDigits: n < 10 ? 2 : 0 })}`;
}

/** Rupiah with decimals for tiny amounts (per-hour costs are often < Rp 10). */
export function rupiahFine(n: number | null | undefined): string {
  if (n == null) return "–";
  if (Math.abs(n) >= 100) return rupiah(n);
  return `Rp ${n.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

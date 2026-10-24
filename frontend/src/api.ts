import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("auth-required"));
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** Fetch `path` now and every `intervalMs`. */
export function usePoll<T>(path: string, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [path]);

  useEffect(() => {
    reload();
    if (!intervalMs) return;
    const id = setInterval(reload, intervalMs);
    return () => clearInterval(id);
  }, [reload, intervalMs]);

  return { data, error, reload };
}

export type Live = {
  ts: number;
  cpu: { percent: number; per_core: number[]; freq_mhz: number | null; load: number[] };
  mem: { total: number; used: number; percent: number; cached: number; buffers: number };
  swap: { total: number; used: number; percent: number };
  temps: {
    cpu: number | null;
    gpu: number | null;
    nvme: number | null;
    pch: number | null;
    acpi: number | null;
    cores: number[];
    all: { chip: string; label: string; current: number; high: number | null; critical: number | null }[];
  };
  fans: { chip: string; label: string; rpm: number }[];
  net: { rx: number; tx: number; per_nic: Record<string, { rx: number; tx: number }> };
  disk: { r: number; w: number; per_disk: Record<string, { r: number; w: number }> };
  uptime: number;
  profile: string | null;
  power: LivePower;
  gpu: { nvidia: NvidiaGpu | null; intel: IntelGpu | null };
};

export type NvidiaGpu = {
  present: boolean;
  name?: string;
  driver: string | null;
  state: string | null; // runtime PM: active / suspended
  power_state: string | null; // D0 / D3cold
  power_w?: number | null;
  power_estimated?: boolean;
  metrics: {
    util: number | null;
    mem_util: number | null;
    vram_used_mib: number | null;
    vram_total_mib: number | null;
    temp: number | null;
    clock_mhz: number | null;
    clock_max_mhz: number | null;
    pstate: string | null;
    power_limit_w: number | null;
  } | null;
  procs: { pid: number; name: string; vram_mib: number | null }[];
};

export type IntelGpu = { name: string | null; freq_mhz: number | null; max_mhz: number | null; min_mhz: number | null; busy: number | null };

export type LiveApp = { name: string; w: number; cpu: number | null; mem: number | null; procs: number | null };

export type LivePower = {
  source: "wattseal" | "rapl" | null;
  total: number | null;
  components: Record<"cpu" | "ram" | "gpu" | "disk" | "net" | "overhead", number | null> | null;
  rapl: { package?: number; core?: number; uncore?: number; dram?: number } | null;
  apps: LiveApp[];
  wattseal: {
    ok: boolean;
    error: string | null;
    raw_total: number | null;
    raw_disk: number | null;
    raw_net: number | null;
    cpu_usage: number | null;
  };
  battery: { percent: number; plugged: boolean } | null;
};

const STALE_MS = 4000; // no live message for this long -> reconnect
const LIVE_HISTORY = 120; // seconds kept for live sparklines

/** Live stream over WebSocket, with a rolling buffer for sparklines. */
export function useLive() {
  const [live, setLive] = useState<Live | null>(null);
  const [connected, setConnected] = useState(false);
  const history = useRef<Live[]>([]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    let lastMsg = Date.now();
    // a stalled tunnel can leave the socket "open" with no data: reconnect if silent
    const watchdog = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMsg > STALE_MS) ws.close();
    }, 1000);

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/live`);
      lastMsg = Date.now();
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        const snap: Live = JSON.parse(ev.data);
        history.current = [...history.current.slice(-(LIVE_HISTORY - 1)), snap];
        setLive(snap);
      };
      ws.onclose = (ev) => {
        setConnected(false);
        if (ev.code === 4401) {
          window.dispatchEvent(new Event("auth-required"));
          return;
        }
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      ws?.close();
    };
  }, []);

  return { live, connected, history: history.current };
}

"""Samples the system every second, broadcasts to websocket clients, and
writes one averaged row per minute to SQLite."""
import asyncio
import time

import psutil

from . import db
from .collectors import gpu, power, system
from .config import SAMPLE_INTERVAL

latest: dict = {}
subscribers: set[asyncio.Queue] = set()


class MinuteBucket:
    FIELDS = ("cpu", "mem", "swap", "load1", "cpu_temp", "gpu_temp", "nvme_temp",
              "net_rx", "net_tx", "disk_r", "disk_w", "watts", "rapl_pkg", "rapl_dram",
              "p_cpu", "p_ram", "p_gpu", "p_disk", "p_net", "p_overhead", "ws_raw",
              "gpu_util", "gpu_vram", "gpu_awake", "fan_cpu", "fan_gpu")

    def __init__(self, minute: int):
        self.minute = minute
        self.sums = {f: 0.0 for f in self.FIELDS}
        self.counts = {f: 0 for f in self.FIELDS}
        self.wh = 0.0
        self.watts_max = None
        self.seconds = 0.0

    def add(self, values: dict, dt: float) -> None:
        for f in self.FIELDS:
            v = values.get(f)
            if v is not None:
                self.sums[f] += v
                self.counts[f] += 1
        w = values.get("watts")
        if w is not None:
            self.wh += w * dt / 3600
            self.watts_max = w if self.watts_max is None else max(self.watts_max, w)
            self.seconds += dt

    def row(self) -> dict:
        row = {"ts": self.minute}
        for f in self.FIELDS:
            row[f] = self.sums[f] / self.counts[f] if self.counts[f] else None
        row.update(wh=self.wh if self.seconds else None, watts_max=self.watts_max, seconds=round(self.seconds))
        return row


async def run() -> None:
    rates = system.RateCounter()
    gpus = gpu.Gpus()
    psutil.cpu_percent(percpu=True)  # prime
    rates.sample()
    bucket = None
    last = time.monotonic()
    loop = asyncio.get_running_loop()
    while True:
        await asyncio.sleep(SAMPLE_INTERVAL)
        now = time.monotonic()
        dt = min(now - last, 5.0)  # cap gaps (e.g. after suspend) so energy isn't over-counted
        last = now
        settings = db.get_settings()
        snap = await loop.run_in_executor(None, system.live, rates)
        snap["gpu"] = await loop.run_in_executor(None, gpus.snapshot)
        nv_temp = ((snap["gpu"]["nvidia"] or {}).get("metrics") or {}).get("temp")
        if nv_temp is not None:
            snap["temps"]["gpu"] = nv_temp
        snap["power"] = power.snapshot(float(settings["overhead_watts"]),
                                       snap["disk"]["per_disk"], snap["net"]["per_nic"], snap["gpu"])
        latest.clear()
        latest.update(snap)
        for q in list(subscribers):
            if q.full():
                q.get_nowait()
            q.put_nowait(snap)

        values = {
            "cpu": snap["cpu"]["percent"], "mem": snap["mem"]["percent"], "swap": snap["swap"]["percent"],
            "load1": snap["cpu"]["load"][0], "cpu_temp": snap["temps"]["cpu"],
            "gpu_temp": snap["temps"]["gpu"], "nvme_temp": snap["temps"]["nvme"],
            "net_rx": snap["net"]["rx"], "net_tx": snap["net"]["tx"],
            "disk_r": snap["disk"]["r"], "disk_w": snap["disk"]["w"],
            "watts": snap["power"]["total"],
        }
        rapl = snap["power"]["rapl"] or {}
        values["rapl_pkg"], values["rapl_dram"] = rapl.get("package"), rapl.get("dram")
        for key, value in (snap["power"]["components"] or {}).items():
            values[f"p_{key}"] = value
        if snap["power"]["source"] == "wattseal":
            values["ws_raw"] = snap["power"]["wattseal"]["raw_total"]
        nv = snap["gpu"]["nvidia"]
        if nv and nv.get("driver") == "nvidia":
            awake = nv.get("state") in ("active", "resuming")
            m = nv.get("metrics") or {}
            values["gpu_awake"] = 1.0 if awake else 0.0
            values["gpu_util"] = (m.get("util") or 0.0) if awake else 0.0
            if awake and m.get("vram_total_mib"):
                values["gpu_vram"] = 100 * (m.get("vram_used_mib") or 0) / m["vram_total_mib"]
            elif not awake:
                values["gpu_vram"] = 0.0
        for fan in snap["fans"]:
            if fan["label"] in ("cpu_fan", "gpu_fan"):
                values[f"fan_{fan['label'][:3]}"] = fan["rpm"]
        minute = int(time.time()) // 60 * 60
        if bucket is None:
            bucket = MinuteBucket(minute)
        elif minute != bucket.minute:
            db.insert("samples", bucket.row())
            if minute % 86400 == 0:
                db.prune()
            bucket = MinuteBucket(minute)
        bucket.add(values, dt)


def history(seconds: int, points: int = 360) -> list[dict]:
    step = max(60, seconds // points // 60 * 60)
    since = int(time.time()) - seconds
    return db.query(
        f"""SELECT ts / {step} * {step} AS ts,
                   AVG(cpu) AS cpu, AVG(mem) AS mem, AVG(swap) AS swap, AVG(load1) AS load1,
                   AVG(cpu_temp) AS cpu_temp, AVG(gpu_temp) AS gpu_temp, AVG(nvme_temp) AS nvme_temp,
                   AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx,
                   AVG(disk_r) AS disk_r, AVG(disk_w) AS disk_w,
                   AVG(watts) AS watts, MAX(watts_max) AS watts_max,
                   AVG(rapl_pkg) AS rapl_pkg, AVG(rapl_dram) AS rapl_dram,
                   AVG(p_cpu) AS p_cpu, AVG(p_ram) AS p_ram, AVG(p_gpu) AS p_gpu,
                   AVG(p_disk) AS p_disk, AVG(p_net) AS p_net, AVG(p_overhead) AS p_overhead,
                   AVG(gpu_util) AS gpu_util, AVG(gpu_vram) AS gpu_vram, AVG(gpu_awake) AS gpu_awake,
                   AVG(fan_cpu) AS fan_cpu, AVG(fan_gpu) AS fan_gpu
            FROM samples WHERE ts >= ? GROUP BY 1 ORDER BY 1""",
        (since,),
    )

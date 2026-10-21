"""GPU readings without keeping the discrete GPU awake.

The NVIDIA dGPU powers off (runtime D3cold) when idle. Any NVML/nvidia-smi call
wakes it, so we read its sleep state from sysfs every second and only run
nvidia-smi while it is already awake. Once it looks idle we stop polling for a
while so the driver's 5 s autosuspend timer can run out.

The Intel iGPU is read from i915 sysfs; its power is part of the CPU package (RAPL).
"""
import shutil
import subprocess
import time
from pathlib import Path

from .system import pci_name

NVIDIA_VENDOR = "0x10de"
INTEL_VENDOR = "0x8086"
POLL_EVERY = 3        # seconds between nvidia-smi calls while awake and busy
IDLE_BACKOFF = 30     # seconds to leave an idle-looking GPU alone so it can suspend
FALLBACK_TDP = 80.0   # typical laptop dGPU TGP, used if the driver reports no power limit

GPU_FIELDS = ("name", "power.draw", "power.limit", "utilization.gpu", "utilization.memory",
              "memory.used", "memory.total", "temperature.gpu", "clocks.sm", "clocks.max.sm", "pstate")


def _read(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _num(v: str | None) -> float | None:
    try:
        return float(v)  # "[N/A]" and friends -> None
    except (TypeError, ValueError):
        return None


def _find(vendor: str) -> Path | None:
    for dev in Path("/sys/bus/pci/devices").iterdir():
        if _read(dev / "vendor") == vendor and (_read(dev / "class") or "").startswith("0x03"):
            return dev
    return None


def estimate_watts(tdp: float, util: float) -> float:
    """WattSeal's GPU model (collector/src/sensors/gpu/estimation.rs)."""
    u = min(max(util / 100, 0.0), 1.0)
    idle = tdp * 0.1
    return idle + (tdp - idle) * u ** 1.6


class Nvidia:
    def __init__(self):
        self.dev = _find(NVIDIA_VENDOR)
        self.smi = shutil.which("nvidia-smi")
        self.last: dict | None = None
        self.last_poll = 0.0
        self.quiet_until = 0.0
        self.idle_w: float | None = None  # lowest power seen at 0% load (P8), learned

    def snapshot(self) -> dict | None:
        if self.dev is None:
            return None
        driver_link = self.dev / "driver"
        driver = driver_link.resolve().name if driver_link.exists() else None
        state = _read(self.dev / "power" / "runtime_status")  # active / suspended
        out = {"present": True, "name": pci_name(self.dev), "driver": driver, "state": state,
               "power_state": _read(self.dev / "power_state"), "metrics": None, "procs": []}
        if driver != "nvidia" or not self.smi:
            return out
        if state != "active":
            self.last = None
            out["power_w"] = 0.0
            return out
        now = time.monotonic()
        if now >= self.quiet_until and now - self.last_poll >= POLL_EVERY:
            self.last_poll = now
            self.last = self._query()
            busy = self.last and ((self.last["metrics"].get("util") or 0) > 0 or self.last["procs"])
            if self.last and not busy:
                self.quiet_until = now + IDLE_BACKOFF
                if not self.last["power_estimated"] and self.last["metrics"].get("pstate") == "P8":
                    self.idle_w = min(self.idle_w or self.last["power_w"], self.last["power_w"])
        if self.last:
            out.update(self.last)
            if now < self.quiet_until:
                # Not polling so it can suspend: the last reading may be the P0 spike right after
                # waking, so count it as idle instead
                idle = self.idle_w or estimate_watts(self.last["metrics"].get("power_limit_w") or FALLBACK_TDP, 0)
                out["power_w"] = idle
                out["power_estimated"] = self.idle_w is None
                out["metrics"] = {**self.last["metrics"], "util": 0.0, "pstate": "idle"}
        return out

    def _query(self) -> dict | None:
        try:
            gpu = subprocess.run(
                [self.smi, f"--query-gpu={','.join(GPU_FIELDS)}", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip().splitlines()
            apps = subprocess.run(
                [self.smi, "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip().splitlines()
        except (OSError, subprocess.TimeoutExpired):
            return None
        if not gpu:
            return None
        v = dict(zip(GPU_FIELDS, (x.strip() for x in gpu[0].split(","))))
        util = _num(v["utilization.gpu"])
        power = _num(v["power.draw"])
        limit = _num(v["power.limit"])
        estimated = power is None
        if estimated:
            power = estimate_watts(limit or FALLBACK_TDP, util or 0)
        procs = []
        for line in apps:
            parts = [p.strip() for p in line.split(",")]
            if len(parts) == 3 and parts[0].isdigit():
                procs.append({"pid": int(parts[0]), "name": Path(parts[1]).name, "vram_mib": _num(parts[2])})
        return {
            "power_w": power,
            "power_estimated": estimated,
            "metrics": {
                "util": util, "mem_util": _num(v["utilization.memory"]),
                "vram_used_mib": _num(v["memory.used"]), "vram_total_mib": _num(v["memory.total"]),
                "temp": _num(v["temperature.gpu"]), "clock_mhz": _num(v["clocks.sm"]),
                "clock_max_mhz": _num(v["clocks.max.sm"]), "pstate": v["pstate"], "power_limit_w": limit,
            },
            "procs": procs,
        }


class Intel:
    def __init__(self):
        self.card = None
        dev = _find(INTEL_VENDOR)
        self.name = pci_name(dev) if dev else None
        if dev:
            for card in (dev / "drm").glob("card*"):
                self.card = card
        self.prev: tuple[float, float] | None = None

    def snapshot(self) -> dict | None:
        if self.card is None:
            return None
        act = _num(_read(self.card / "gt_act_freq_mhz"))
        rc6 = _num(_read(self.card / "power" / "rc6_residency_ms"))
        busy = None
        now = time.monotonic() * 1000
        if rc6 is not None:
            if self.prev:
                dt = now - self.prev[0]
                if dt > 0:
                    busy = min(max(100 * (1 - (rc6 - self.prev[1]) / dt), 0.0), 100.0)
            self.prev = (now, rc6)
        return {
            "name": self.name,
            "freq_mhz": act,
            "max_mhz": _num(_read(self.card / "gt_max_freq_mhz")),
            "min_mhz": _num(_read(self.card / "gt_RPn_freq_mhz")),
            "busy": busy,
        }


class Gpus:
    def __init__(self):
        self.nvidia = Nvidia()
        self.intel = Intel()

    def snapshot(self) -> dict:
        return {"nvidia": self.nvidia.snapshot(), "intel": self.intel.snapshot()}

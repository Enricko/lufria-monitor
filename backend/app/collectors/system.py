import json
from functools import lru_cache
import platform
import socket
import subprocess
import time
from pathlib import Path

import psutil

from ..config import SMART_FILE

REAL_FS = {"ext4", "ext3", "xfs", "btrfs", "vfat", "exfat", "ntfs", "ntfs3", "f2fs", "zfs"}


def _read(path: str) -> str | None:
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def _cpu_model() -> str:
    for line in Path("/proc/cpuinfo").read_text().splitlines():
        if line.startswith("model name"):
            return line.split(":", 1)[1].strip()
    return platform.processor()


def _os_name() -> str:
    for line in Path("/etc/os-release").read_text().splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    return platform.system()


PCI_IDS = Path("/usr/share/misc/pci.ids")


@lru_cache(maxsize=1)
def _pci_names() -> dict[tuple[str, str | None], str]:
    """vendor / (vendor, device) -> name from pci.ids."""
    names: dict[tuple[str, str | None], str] = {}
    vendor = None
    try:
        lines = PCI_IDS.read_text(errors="replace").splitlines()
    except OSError:
        return names
    for line in lines:
        if not line or line.startswith("#") or line.startswith("\t\t"):
            continue
        if line.startswith("C "):
            break  # device classes section
        if line.startswith("\t"):
            dev, _, name = line[1:].partition("  ")
            if vendor:
                names[(vendor, dev.lower())] = name
        else:
            vendor, _, name = line.partition("  ")
            vendor = vendor.lower()
            names[(vendor, None)] = name
    return names


def pci_name(dev: Path) -> str:
    """Readable device name from sysfs IDs, e.g. 'NVIDIA GeForce GTX 1660 Ti Mobile'."""
    names = _pci_names()
    vid = (_read(str(dev / "vendor")) or "")[2:].lower()
    did = (_read(str(dev / "device")) or "")[2:].lower()
    vendor = names.get((vid, None), vid).replace(" Corporation", "")
    model = names.get((vid, did), did)
    if "[" in model and model.endswith("]"):  # "TU116M [GeForce GTX 1660 Ti Mobile]" -> marketing name
        model = model[model.index("[") + 1:-1]
    vendor = vendor.split()[0]  # "Intel", "NVIDIA", "Advanced" -> keep it short
    return f"{'AMD' if vendor == 'Advanced' else vendor} {model}"


def _gpus() -> list[dict]:
    """GPUs from sysfs IDs + pci.ids. Never run lspci: reading PCI config space
    wakes a runtime-suspended dGPU out of D3cold."""
    out = []
    names = _pci_names()
    for dev in sorted(Path("/sys/bus/pci/devices").iterdir()):
        cls = _read(str(dev / "class")) or ""
        if not cls.startswith("0x03"):
            continue
        vid = (_read(str(dev / "vendor")) or "")[2:].lower()
        did = (_read(str(dev / "device")) or "")[2:].lower()
        vendor = names.get((vid, None), vid).replace(" Corporation", "")
        drv = dev / "driver"
        out.append({"name": f"{vendor} {names.get((vid, did), did)}",
                    "driver": drv.resolve().name if drv.exists() else None})
    return out


def block_devices() -> list[dict]:
    try:
        out = subprocess.run(
            ["lsblk", "-J", "-b", "-o", "NAME,SIZE,MODEL,TYPE,ROTA,TRAN,FSTYPE,MOUNTPOINTS"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        devs = json.loads(out)["blockdevices"]
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError):
        return []
    return [d for d in devs if d.get("type") == "disk" and not d["name"].startswith(("loop", "zram"))]


def specs() -> dict:
    gpus = _gpus()
    vm = psutil.virtual_memory()
    freq = psutil.cpu_freq()
    nics = []
    for name, addrs in psutil.net_if_addrs().items():
        if name == "lo":
            continue
        ipv4 = [a.address for a in addrs if a.family == socket.AF_INET]
        stats = psutil.net_if_stats().get(name)
        nics.append({
            "name": name, "ipv4": ipv4,
            "up": bool(stats and stats.isup), "speed_mbps": stats.speed if stats else 0,
        })
    return {
        "hostname": socket.gethostname(),
        "vendor": _read("/sys/class/dmi/id/sys_vendor"),
        "product": _read("/sys/class/dmi/id/product_name"),
        "bios": _read("/sys/class/dmi/id/bios_version"),
        "os": _os_name(),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "python": platform.python_version(),
        "cpu": {
            "model": _cpu_model(),
            "cores": psutil.cpu_count(logical=False),
            "threads": psutil.cpu_count(logical=True),
            "max_mhz": freq.max if freq else None,
            "min_mhz": freq.min if freq else None,
        },
        "memory_total": vm.total,
        "swap_total": psutil.swap_memory().total,
        "gpus": [g["name"] for g in gpus],
        "gpu_drivers": [g["driver"] for g in gpus],
        "disks": [
            {"name": d["name"], "size": d["size"], "model": (d.get("model") or "").strip(),
             "rotational": d.get("rota"), "transport": d.get("tran")}
            for d in block_devices()
        ],
        "nics": nics,
        "boot_time": psutil.boot_time(),
    }


def temperatures() -> dict:
    temps = psutil.sensors_temperatures()
    result: dict = {"cpu": None, "gpu": None, "nvme": None, "pch": None, "acpi": None, "cores": [], "all": []}
    for chip, entries in temps.items():
        for e in entries:
            result["all"].append({"chip": chip, "label": e.label or chip, "current": e.current,
                                  "high": e.high, "critical": e.critical})
            if chip == "coretemp":
                if e.label.startswith("Package"):
                    result["cpu"] = e.current
                elif e.label.startswith("Core"):
                    result["cores"].append(e.current)
            elif chip == "nouveau" or chip == "amdgpu" or chip == "nvidia":
                result["gpu"] = e.current if result["gpu"] is None else result["gpu"]
            elif chip.startswith("nvme") and result["nvme"] is None:
                result["nvme"] = e.current
            elif chip.startswith("pch") and result["pch"] is None:
                result["pch"] = e.current
    acpi = next((v for k, v in temps.items() if k.startswith("acpitz")), None)
    result["acpi"] = acpi[0].current if acpi else None
    if result["cpu"] is None and acpi:
        result["cpu"] = acpi[0].current
    return result


def fans() -> list[dict]:
    return [{"chip": chip, "label": f.label or chip, "rpm": f.current}
            for chip, entries in psutil.sensors_fans().items() for f in entries]


def storage() -> dict:
    mounts = []
    seen = set()
    for p in psutil.disk_partitions(all=False):
        if p.fstype not in REAL_FS or p.device in seen or p.mountpoint.startswith("/snap"):
            continue
        seen.add(p.device)
        try:
            u = psutil.disk_usage(p.mountpoint)
        except OSError:
            continue
        mounts.append({"device": p.device, "mountpoint": p.mountpoint, "fstype": p.fstype,
                       "total": u.total, "used": u.used, "free": u.free, "percent": u.percent})
    try:
        smart = json.loads(SMART_FILE.read_text())
    except (OSError, ValueError):
        smart = {}
    disks = []
    for d in block_devices():
        s = smart.get(d["name"], {})
        disks.append({
            "name": d["name"], "size": d["size"], "model": (d.get("model") or "").strip(),
            "rotational": d.get("rota"), "transport": d.get("tran"),
            "mounted": any(_has_mount(d)),
            "partitions": [
                {"name": c["name"], "size": c["size"], "fstype": c.get("fstype"),
                 "mountpoints": [m for m in (c.get("mountpoints") or []) if m]}
                for c in d.get("children", [])
            ],
            "smart": s,
        })
    return {"mounts": mounts, "disks": disks, "smart_updated": smart.get("_ts")}


def _has_mount(dev: dict):
    for m in dev.get("mountpoints") or []:
        if m:
            yield True
    for child in dev.get("children", []):
        yield from _has_mount(child)


def top_processes(limit: int = 12) -> dict:
    procs = []
    for p in psutil.process_iter(["pid", "name", "username", "memory_info", "cpu_percent", "cmdline"]):
        info = p.info
        if info["memory_info"] is None:
            continue
        procs.append({
            "pid": info["pid"], "name": info["name"], "user": info["username"],
            "cpu": info["cpu_percent"] or 0.0, "rss": info["memory_info"].rss,
            "cmd": " ".join(info["cmdline"] or [])[:160],
        })
    return {
        "by_cpu": sorted(procs, key=lambda p: p["cpu"], reverse=True)[:limit],
        "by_mem": sorted(procs, key=lambda p: p["rss"], reverse=True)[:limit],
        "count": len(procs),
    }


class RateCounter:
    """Turns cumulative psutil counters into per-second rates."""

    def __init__(self):
        self.prev_t = None
        self.prev_net = None
        self.prev_disk = None

    def sample(self) -> dict:
        now = time.monotonic()
        net = psutil.net_io_counters(pernic=True)
        disk = psutil.disk_io_counters(perdisk=True)
        out = {"net": {}, "disk": {}, "net_rx": 0.0, "net_tx": 0.0, "disk_r": 0.0, "disk_w": 0.0}
        if self.prev_t is not None:
            dt = max(now - self.prev_t, 1e-3)
            for nic, c in net.items():
                p = self.prev_net.get(nic)
                if nic == "lo" or p is None:
                    continue
                rx = max(c.bytes_recv - p.bytes_recv, 0) / dt
                tx = max(c.bytes_sent - p.bytes_sent, 0) / dt
                out["net"][nic] = {"rx": rx, "tx": tx}
                if not nic.startswith(("docker", "br-", "veth")):
                    out["net_rx"] += rx
                    out["net_tx"] += tx
            for name, c in disk.items():
                p = self.prev_disk.get(name)
                # whole disks only (sda, nvme0n1), skip partitions/loop/dm
                if p is None or name.startswith(("loop", "dm-", "zram")) or _is_partition(name):
                    continue
                r = max(c.read_bytes - p.read_bytes, 0) / dt
                w = max(c.write_bytes - p.write_bytes, 0) / dt
                out["disk"][name] = {"r": r, "w": w}
                out["disk_r"] += r
                out["disk_w"] += w
        self.prev_t, self.prev_net, self.prev_disk = now, net, disk
        return out


def _is_partition(name: str) -> bool:
    return Path(f"/sys/class/block/{name}/partition").exists()


def live(rates: RateCounter) -> dict:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    per_core = psutil.cpu_percent(percpu=True)
    freqs = psutil.cpu_freq(percpu=True)
    load = psutil.getloadavg()
    io = rates.sample()
    return {
        "ts": time.time(),
        "cpu": {
            "percent": sum(per_core) / len(per_core) if per_core else 0.0,
            "per_core": per_core,
            "freq_mhz": sum(f.current for f in freqs) / len(freqs) if freqs else None,
            "load": load,
        },
        "mem": {"total": vm.total, "used": vm.total - vm.available, "percent": vm.percent,
                "cached": getattr(vm, "cached", 0), "buffers": getattr(vm, "buffers", 0)},
        "swap": {"total": sw.total, "used": sw.used, "percent": sw.percent},
        "temps": temperatures(),
        "fans": fans(),
        "net": {"rx": io["net_rx"], "tx": io["net_tx"], "per_nic": io["net"]},
        "disk": {"r": io["disk_r"], "w": io["disk_w"], "per_disk": io["disk"]},
        "uptime": time.time() - psutil.boot_time(),
        "profile": _read("/sys/firmware/acpi/platform_profile"),
    }

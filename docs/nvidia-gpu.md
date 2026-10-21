# NVIDIA laptop GPUs

A laptop dGPU used for occasional compute (CUDA, OpenCL, NVENC) should be **powered off (D3cold, ≈0 W) when
idle**. Two things get in the way: the driver, and the monitoring itself.

## 1. Driver: let the GPU power off

Notes from a GTX 1660 Ti Mobile (Turing) on Ubuntu 26.04, driver 595, Secure Boot on:

| Setup | `Runtime D3 status` | Idle draw |
|---|---|---|
| nouveau | (runtime PM by the kernel) | D3cold, ≈0 W, but no CUDA and no power telemetry |
| nvidia **open** module (always uses GSP firmware) | **Not supported** | P8, ≈7 W, forever |
| nvidia **closed** module, `NVreg_EnableGpuFirmware=0` | **Enabled (fine-grained)** | D3cold, ≈0 W, about 13 s after the last job |

Every requirement in NVIDIA's [RTD3 documentation](https://download.nvidia.com/XFree86/Linux-x86_64/595.58.03/README/dynamicpowermanagement.html)
was met in both cases (Turing GPU, Coffee Lake chipset, ACPI `_PR0`/`_PR3`, kernel ≥ 4.18). What made the
difference was the GSP firmware. Turing also needs `NVreg_DynamicPowerManagement=0x02`, because the default
`0x03` only enables RTD3 on Ampere and newer.

`sudo deploy/setup-nvidia.sh` installs that setup:
- **Packages:** `linux-modules-nvidia-595-generic` (Canonical-signed prebuilt modules, so Secure Boot works without MOK enrolment), `nvidia-headless-no-dkms-595` (no X server) and `nvidia-utils-595`.
- **Module options:** `/etc/modprobe.d/nvidia-runtime-pm.conf` with both options above.
- **Services:** `nvidia-powerd` is disabled. Dynamic Boost is Ampere+ only and would only poke the GPU.

Apply it without a reboot, if nothing is using the GPU:

```bash
sudo modprobe -r nvidia_drm nvidia_modeset nvidia_uvm nvidia && sudo modprobe nvidia
deploy/check-gpu.sh
```

Expected output:

```
Runtime D3 status:          Enabled (fine-grained)
...
runtime: suspended   D3cold
```

Ubuntu's `nvidia-persistenced` runs with `--no-persistence-mode`, so it doesn't keep the GPU up.

## 2. Monitoring without waking it

Anything that touches a sleeping GPU wakes it, and it then stays in P0 or P8 for a while. Things that
**wake** it:

- `nvidia-smi` and anything else using NVML, including WattSeal's 1-second GPU polling.
- `lspci`, or anything else that reads **PCI config space** (`/sys/bus/pci/devices/*/config`).

Things that **don't** wake it:
- Reading sysfs attributes such as `vendor`, `device`, `class`, `power/runtime_status` and `power_state`.
- `psutil`'s temperature and fan sensors.

So the monitor works like this:
- **Sleep state:** `backend/app/collectors/gpu.py` reads `power/runtime_status` every second. Only when it is
  already `active` does it run `nvidia-smi`, at most every 3 s. Once the GPU looks idle (0% load, no
  processes) it stops polling for 30 s so the driver's idle timer can expire.
- **Power while not polling:** the last reading may be the P0 spike right after waking, so the learned P8
  idle draw (or WattSeal's model) is reported instead.
- **Device names:** they come from sysfs IDs plus `/usr/share/misc/pci.ids`, never from `lspci`.
- **WattSeal:** `wattseal.service` runs with `PrivateDevices=yes`, so it can't open `/dev/nvidia*` at all.
  The helper covers the GPU instead.

The Graphics card on the System page shows the state, and how much of the selected history range the
dGPU was awake.

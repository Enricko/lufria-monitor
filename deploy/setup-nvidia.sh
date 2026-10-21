#!/usr/bin/env bash
# NVIDIA GTX 1660 Ti (Turing, laptop) as a headless compute GPU that powers off when idle.
# Run: sudo deploy/setup-nvidia.sh   (then reload the modules or reboot; check with deploy/check-gpu.sh)
#
# Why the *closed* kernel module: the open module always runs GSP firmware, and with GSP this
# GPU reports "Runtime D3 status: Not supported" -> it idles at ~7 W in P8 forever.
# The closed module with NVreg_EnableGpuFirmware=0 gets "Enabled (fine-grained)" -> D3cold, ~0 W.
# Canonical-signed prebuilt modules, so it works with Secure Boot (no DKMS / MOK enrolment).
set -euo pipefail
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
  linux-modules-nvidia-595-generic nvidia-headless-no-dkms-595 nvidia-utils-595

cat > /etc/modprobe.d/nvidia-runtime-pm.conf <<'CONF'
# Lufria Monitor: let the Turing dGPU power off (RTD3/D3cold) when idle. Ampere+ does this by default; Turing needs 0x02.
options nvidia NVreg_DynamicPowerManagement=0x02
# Closed kernel module: run without GSP firmware (with GSP this Turing GPU reported RTD3 'Not supported')
options nvidia NVreg_EnableGpuFirmware=0
CONF

# Dynamic Boost daemon is Ampere+ only and would just poke the GPU
systemctl disable --now nvidia-powerd 2>/dev/null || true
update-initramfs -u
echo "Done. Reboot (or modprobe -r nvidia_drm nvidia_modeset nvidia_uvm nvidia && modprobe nvidia)."

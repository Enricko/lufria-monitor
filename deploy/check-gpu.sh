#!/usr/bin/env bash
# Post-reboot check for the NVIDIA driver + runtime power management.
D=/sys/bus/pci/devices/0000:01:00.0
echo "kernel:  $(uname -r)"
echo "driver:  $(basename "$(readlink $D/driver)")   runtime: $(cat $D/power/runtime_status)   $(cat $D/power_state)"
grep -h "Runtime D3 status" /proc/driver/nvidia/gpus/*/power 2>/dev/null
echo "--- nvidia-smi (wakes the GPU briefly)"
nvidia-smi --query-gpu=name,driver_version,pstate,power.draw,power.limit,temperature.gpu,memory.total --format=csv
echo "--- waiting 15 s for it to sleep again"
sleep 15
echo "runtime: $(cat $D/power/runtime_status)   $(cat $D/power_state)"
systemctl is-active wattseal lufria-monitor-helper lufria-monitor cloudflared docker hermes-webui lufria-portfolio | paste -sd' '

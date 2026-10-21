#!/usr/bin/env bash
# All-resource stress test, to watch the dashboard react: CPU, RAM, disk and (optionally) the GPU via OpenCL.
#   tools/stress-test.sh [seconds]          default 180
#   PYTHON=/path/to/venv/bin/python tools/stress-test.sh   # interpreter with pyopencl + numpy for the GPU part
# Needs stress-ng (sudo apt install stress-ng).
set -euo pipefail
DUR="${1:-180}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python3}"
TMPD="$(mktemp -d /var/tmp/lufria-stress.XXXXXX)"   # on disk, not tmpfs
trap 'rm -rf "$TMPD"' EXIT

AVAIL_MB=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
VM_MB=$(( AVAIL_MB * 70 / 100 ))   # --vm-bytes is the total across instances; keep headroom so nothing is OOM-killed
echo "CPU: $(nproc) threads | RAM: ${VM_MB} MB | disk: $TMPD | ${DUR}s"

stress-ng --cpu "$(nproc)" --cpu-method matrixprod \
          --vm 4 --vm-bytes "${VM_MB}M" --vm-keep \
          --hdd 2 --hdd-bytes 1G --temp-path "$TMPD" \
          --timeout "${DUR}s" --metrics-brief &
if "$PYTHON" -c "import pyopencl, numpy" 2>/dev/null; then
  "$PYTHON" "$DIR/gpu_burn.py" "$DUR" &
else
  echo "GPU: skipped (install pyopencl + numpy, or set PYTHON=)"
fi
wait

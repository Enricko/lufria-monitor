#!/usr/bin/env bash
# Installs WattSeal (https://github.com/Daminoup88/WattSeal) as a headless root service.
# Run: sudo deploy/install-wattseal.sh
set -euo pipefail
VERSION=v1.0.6
SHA256=96b386aa0f1469519fde997885bc6b4a60385b796831b7bcfdde4db32a48276c
DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The Linux release links GTK3 even in --headless mode (it never opens a window)
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends libgtk-3-0t64

curl -fsSL -o "$TMP/WattSeal-linux" "https://github.com/Daminoup88/WattSeal/releases/download/$VERSION/WattSeal-linux"
echo "$SHA256  $TMP/WattSeal-linux" | sha256sum -c -
install -d -m 755 /opt/wattseal
install -m 755 "$TMP/WattSeal-linux" /opt/wattseal/
install -m 644 "$DIR/wattseal.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable wattseal.service
systemctl restart wattseal.service
systemctl --no-pager --lines=0 status wattseal

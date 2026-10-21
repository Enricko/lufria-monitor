#!/usr/bin/env bash
# Installs/updates the Lufria Monitor systemd services.
#   sudo deploy/install.sh                 # runs the dashboard as the user who invoked sudo, on 0.0.0.0:8090
#   sudo PORT=9000 HOST=127.0.0.1 APP_USER=me deploy/install.sh
# Run deploy/bootstrap.sh first (Python venv + frontend build).
# WattSeal (the power collector) is installed separately: sudo deploy/install-wattseal.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$DIR")"
APP_USER="${APP_USER:-${SUDO_USER:-}}"
PORT="${PORT:-8090}"
HOST="${HOST:-0.0.0.0}"

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi
if [ -z "$APP_USER" ] || [ "$APP_USER" = root ]; then
  echo "set APP_USER to the (non-root) user that should run the dashboard" >&2; exit 1
fi
if [ ! -x "$APP_DIR/backend/.venv/bin/uvicorn" ]; then
  echo "backend venv missing - run deploy/bootstrap.sh as $APP_USER first" >&2; exit 1
fi

# Docker access lets the Services page list containers (docker group = root-equivalent; optional)
DOCKER_GROUP=""
if getent group docker >/dev/null; then DOCKER_GROUP="SupplementaryGroups=docker"; fi

install -d -m 755 /opt/lufria-monitor
install -m 755 "$DIR/lufria-monitor-helper.py" /opt/lufria-monitor/
install -m 644 "$DIR/lufria-monitor-helper.service" /etc/systemd/system/
sed -e "s|@USER@|$APP_USER|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@PORT@|$PORT|g" -e "s|@HOST@|$HOST|g" \
    -e "s|@DOCKER_GROUP@|$DOCKER_GROUP|" "$DIR/lufria-monitor.service.in" > /etc/systemd/system/lufria-monitor.service
chmod 644 /etc/systemd/system/lufria-monitor.service

systemctl daemon-reload
systemctl enable --now lufria-monitor-helper.service
systemctl enable lufria-monitor.service
systemctl restart lufria-monitor.service
systemctl --no-pager --lines=0 status lufria-monitor-helper lufria-monitor
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):$PORT"

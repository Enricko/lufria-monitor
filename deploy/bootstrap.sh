#!/usr/bin/env bash
# Builds the app as your normal user: Python venv for the backend + production frontend build.
#   deploy/bootstrap.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(id -u)" -eq 0 ]; then echo "run as your normal user, not root" >&2; exit 1; fi

echo "==> example configuration and data"
if [ ! -f "$APP_DIR/.env" ] && [ -f "$APP_DIR/.env.example" ]; then
    echo "    copying .env.example -> .env"
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi

mkdir -p "$APP_DIR/data"
if [ ! -f "$APP_DIR/data/providers.json" ] && [ -f "$APP_DIR/data/providers.example.json" ]; then
    echo "    copying data/providers.example.json -> data/providers.json"
    cp "$APP_DIR/data/providers.example.json" "$APP_DIR/data/providers.json"
    chmod 600 "$APP_DIR/data/providers.json"
fi

echo "==> backend venv"
python3 -m venv "$APP_DIR/backend/.venv"
"$APP_DIR/backend/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/backend/.venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

echo "==> frontend build"
cd "$APP_DIR/frontend"
npm ci --no-audit --no-fund
npm run build

echo "==> done. Next: set a password, then sudo deploy/install.sh"
echo "    $APP_DIR/backend/.venv/bin/python -m app.auth set   (run inside $APP_DIR/backend)"

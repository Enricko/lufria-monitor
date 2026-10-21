#!/usr/bin/env bash
# Builds the app as your normal user: Python venv for the backend + production frontend build.
#   deploy/bootstrap.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(id -u)" -eq 0 ]; then echo "run as your normal user, not root" >&2; exit 1; fi

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

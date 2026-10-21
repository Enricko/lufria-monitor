#!/usr/bin/env bash
# Downloads the Ookla Speedtest CLI into ./bin (not redistributed in this repo: Ookla's license).
#   deploy/install-speedtest.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=1.2.0
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;; aarch64) ARCH=aarch64 ;; armv7l) ARCH=armhf ;; *) echo "unsupported arch" >&2; exit 1 ;;
esac
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://install.speedtest.net/app/cli/ookla-speedtest-$VERSION-linux-$ARCH.tgz" -o "$TMP/st.tgz"
tar -xzf "$TMP/st.tgz" -C "$TMP" speedtest
install -d "$APP_DIR/bin"
install -m 755 "$TMP/speedtest" "$APP_DIR/bin/speedtest"
"$APP_DIR/bin/speedtest" --version | head -1

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB="$ROOT/webapp"
BUILD="$WEB/wasm/build"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake not found — install/activate emsdk first" >&2
  exit 1
fi

mkdir -p "$BUILD"
emcmake cmake -S "$WEB/wasm" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" -j

# Ensure artifacts land in webapp/ for static serve
if [[ -f "$BUILD/nodruma.js" ]]; then
  cp -f "$BUILD/nodruma.js" "$WEB/nodruma.js"
  cp -f "$BUILD/nodruma.wasm" "$WEB/nodruma.wasm"
fi

echo "WASM ready: $WEB/nodruma.js + nodruma.wasm"

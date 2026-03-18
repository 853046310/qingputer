#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE20_BIN="${NODE20_BIN:-/opt/homebrew/opt/node@20/bin}"
CARGO_BIN_DIR="${CARGO_BIN_DIR:-$HOME/.cargo/bin}"
DESKTOP_DIR="$ROOT_DIR/desktop"
TAURI_TARGET="aarch64-apple-darwin"
DMG_DIR="$DESKTOP_DIR/src-tauri/target/$TAURI_TARGET/release/bundle/dmg"
APP_DIR="$DESKTOP_DIR/src-tauri/target/$TAURI_TARGET/release/bundle/macos"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This packaging script only supports macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This packaging script only builds the arm64 installer on Apple Silicon hosts." >&2
  exit 1
fi

if [[ ! -x "$NODE20_BIN/node" || ! -x "$NODE20_BIN/npm" ]]; then
  echo "Node 20 was not found under $NODE20_BIN" >&2
  echo "Install Homebrew node@20 or set NODE20_BIN to a Node 20 bin directory." >&2
  exit 1
fi

if [[ -d "$CARGO_BIN_DIR" ]]; then
  export PATH="$NODE20_BIN:$CARGO_BIN_DIR:$PATH"
else
  export PATH="$NODE20_BIN:$PATH"
fi

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
  echo "Rust toolchain was not found on PATH." >&2
  echo "Install rustup or set CARGO_BIN_DIR to the directory containing cargo and rustc." >&2
  exit 1
fi

echo "Using Node: $(node -v)"
echo "Using npm:  $(npm -v)"
echo "Using cargo: $(cargo -V)"

"$ROOT_DIR/scripts/build-runtime-macos-arm64.sh"

echo "Installing desktop dependencies with Node 20 ..."
cd "$DESKTOP_DIR"
npm ci

echo "Building Tauri macOS arm64 installer ..."
npm run tauri:build -- --target "$TAURI_TARGET"

echo "Build complete."
if [[ -d "$DMG_DIR" ]]; then
  echo "DMG artifacts:"
  find "$DMG_DIR" -maxdepth 1 -type f | sort
fi
if [[ -d "$APP_DIR" ]]; then
  echo "App bundle:"
  find "$APP_DIR" -maxdepth 1 -type d -name '*.app' | sort
fi

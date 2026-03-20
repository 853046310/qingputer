#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QINGCODE_DIR="$ROOT_DIR/qingcode"
PYTHON_BIN="${PYTHON_BIN:-$QINGCODE_DIR/.venv/bin/python}"
DIST_DIR="$QINGCODE_DIR/dist"
BUILD_DIR="$QINGCODE_DIR/build"
PYINSTALLER_WORK_DIR="$BUILD_DIR/pyinstaller"
RUNTIME_NAME="qingcode-runtime-aarch64-apple-darwin"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This packaging script only supports macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This packaging script only builds the arm64 runtime on Apple Silicon hosts." >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python not found at $PYTHON_BIN" >&2
  echo "Create a venv first: cd $QINGCODE_DIR && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'" >&2
  exit 1
fi

echo "Installing PyInstaller ..."
"$PYTHON_BIN" -m pip install --disable-pip-version-check --quiet "pyinstaller>=6.11,<7"

echo "Building standalone qingcode runtime binary $RUNTIME_NAME ..."
"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name "$RUNTIME_NAME" \
  --distpath "$DIST_DIR" \
  --workpath "$PYINSTALLER_WORK_DIR" \
  --specpath "$PYINSTALLER_WORK_DIR" \
  --paths "$QINGCODE_DIR" \
  --collect-all keyring \
  --collect-all openhands \
  --copy-metadata keyring \
  "$QINGCODE_DIR/app/main.py"

echo "QingCode runtime binary built: $DIST_DIR/$RUNTIME_NAME"

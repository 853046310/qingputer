#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime"
PYTHON_BIN="${PYTHON_BIN:-$RUNTIME_DIR/.venv/bin/python}"
PLAYWRIGHT_BIN="${PLAYWRIGHT_BIN:-$RUNTIME_DIR/.venv/bin/playwright}"
DIST_DIR="$RUNTIME_DIR/dist"
BUILD_DIR="$RUNTIME_DIR/build"
PYINSTALLER_WORK_DIR="$BUILD_DIR/pyinstaller"
BROWSERS_DIR="$BUILD_DIR/playwright-browsers"
PLAYWRIGHT_CACHE_DIR="${PLAYWRIGHT_CACHE_DIR:-$HOME/Library/Caches/ms-playwright}"
RUNTIME_NAME="qingputer-runtime-aarch64-apple-darwin"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This packaging script only supports macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "This packaging script only builds the arm64 runtime on Apple Silicon hosts." >&2
  exit 1
fi

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Missing runtime Python interpreter at $PYTHON_BIN" >&2
  echo "Create the runtime venv first: cd runtime && python3 -m venv .venv && .venv/bin/pip install -e .[dev]" >&2
  exit 1
fi

if [[ ! -x "$PLAYWRIGHT_BIN" ]]; then
  echo "Missing Playwright CLI at $PLAYWRIGHT_BIN" >&2
  echo "Install runtime dependencies first: cd runtime && .venv/bin/pip install -e .[dev]" >&2
  exit 1
fi

echo "Installing PyInstaller into the runtime venv..."
"$PYTHON_BIN" -m pip install --disable-pip-version-check --quiet "pyinstaller>=6.11,<7"

echo "Resolving required Playwright browser assets..."
required_browser_names=()
while IFS= read -r browser_path; do
  [[ -n "$browser_path" ]] || continue
  required_browser_names+=("$(basename "$browser_path")")
done < <(
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_CACHE_DIR" \
    "$PLAYWRIGHT_BIN" install --dry-run chromium --no-shell |
    sed -n 's/^  Install location:[[:space:]]*//p'
)

if [[ ${#required_browser_names[@]} -eq 0 ]]; then
  echo "Could not determine required Playwright browser assets." >&2
  exit 1
fi

reuse_staged_browsers=true
for browser_name in "${required_browser_names[@]}"; do
  if [[ ! -f "$BROWSERS_DIR/$browser_name/INSTALLATION_COMPLETE" ]]; then
    reuse_staged_browsers=false
    break
  fi
done

if [[ "$reuse_staged_browsers" == true ]]; then
  echo "Reusing staged Playwright browsers from $BROWSERS_DIR"
else
  echo "Staging Playwright Chromium into $BROWSERS_DIR ..."
  rm -rf "$BROWSERS_DIR"
  mkdir -p "$BROWSERS_DIR"

  missing_browser_assets=()
  for browser_name in "${required_browser_names[@]}"; do
    if [[ -f "$PLAYWRIGHT_CACHE_DIR/$browser_name/INSTALLATION_COMPLETE" ]]; then
      echo "Copying Playwright asset from local cache: $browser_name"
      ditto "$PLAYWRIGHT_CACHE_DIR/$browser_name" "$BROWSERS_DIR/$browser_name"
    else
      missing_browser_assets+=("$browser_name")
    fi
  done

  if [[ ${#missing_browser_assets[@]} -gt 0 ]]; then
    echo "Downloading missing Playwright assets: ${missing_browser_assets[*]}"
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" "$PLAYWRIGHT_BIN" install chromium --no-shell
  fi
fi

echo "Building standalone runtime binary $RUNTIME_NAME ..."
rm -rf "$PYINSTALLER_WORK_DIR"
mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/$RUNTIME_NAME"

"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name "$RUNTIME_NAME" \
  --distpath "$DIST_DIR" \
  --workpath "$PYINSTALLER_WORK_DIR" \
  --specpath "$PYINSTALLER_WORK_DIR" \
  --paths "$RUNTIME_DIR" \
  --collect-all playwright \
  --collect-all keyring \
  --collect-all langgraph \
  --copy-metadata playwright \
  --copy-metadata keyring \
  "$RUNTIME_DIR/app/main.py"

if [[ ! -x "$DIST_DIR/$RUNTIME_NAME" ]]; then
  echo "Runtime build did not produce $DIST_DIR/$RUNTIME_NAME" >&2
  exit 1
fi

echo "Runtime sidecar ready:"
echo "  $DIST_DIR/$RUNTIME_NAME"
echo "Playwright browsers staged at:"
echo "  $BROWSERS_DIR"

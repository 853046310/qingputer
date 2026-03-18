# Qingputer

Qingputer is a macOS-only local desktop agent built around three capability primitives:

- `terminal`
- `filesystem`
- `browser`

The repository is split into:

- [`desktop/`](/Users/yanqidong/Documents/qingputer/desktop): Tauri 2 + React/Vite desktop shell
- [`runtime/`](/Users/yanqidong/Documents/qingputer/runtime): Python 3.13 runtime sidecar with a LangGraph-based agent loop
- [`docs/`](/Users/yanqidong/Documents/qingputer/docs): architecture, policy, and API contracts

## Local prerequisites

- macOS 13+
- Node.js 20 LTS
- Rust stable + Cargo
- Python 3.13
- Xcode Command Line Tools

## Runtime bootstrap

```bash
cd runtime
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
playwright install chromium
python3 -m app.main
```

The runtime prints a one-line JSON handshake to stdout:

```json
{"port": 51123, "token": "random-bearer-token"}
```

The desktop shell uses that port/token pair to call the local HTTP/WebSocket API.

## Desktop bootstrap

```bash
cd desktop
npm install
npm run tauri:dev
```

During development, the Tauri shell starts the runtime with:

```bash
python3 -m app.main
```

from the [`runtime/`](/Users/yanqidong/Documents/qingputer/runtime) directory.

## macOS arm64 Installer Build

To create a redistributable macOS Apple Silicon installer, run:

```bash
./scripts/package-macos-arm64.sh
```

That script will:

- build a standalone arm64 `qingputer-runtime` sidecar with PyInstaller
- stage the Playwright Chromium runtime into bundle resources
- build a Tauri `.dmg` installer using Node 20

The resulting installer is written under:

```text
desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/
```

Notes:

- the build host must be macOS arm64
- `/opt/homebrew/opt/node@20/bin` must exist, or set `NODE20_BIN=/custom/node20/bin`
- Rust + Cargo must be installed; if `cargo` is not on `PATH`, set `CARGO_BIN_DIR=/custom/cargo/bin`
- unsigned builds can be shared directly, but Gatekeeper will warn on other Macs until the app is codesigned and notarized

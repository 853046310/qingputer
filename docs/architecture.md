# Qingputer Architecture

## Overview

Qingputer v1 is a terminal-first local personal computer agent with three capability primitives:

- `terminal`: shell execution through a login shell PTY
- `filesystem`: structured file reads, writes, and directory listing
- `browser`: isolated Chromium automation through Playwright

The product ships as a macOS desktop application with a Python runtime sidecar.

## Runtime topology

```text
React/Tauri UI
    |
    | localhost HTTP + WebSocket + bearer token
    v
Python runtime sidecar
    |
    +-- SessionManager
    +-- PolicyEngine
    +-- CapabilityRouter
    +-- AuditLogger
    +-- SkillService
    |
    +-- TerminalCapability
    +-- FilesystemCapability
    +-- BrowserCapability
```

## Desktop to runtime handshake

1. Tauri starts the Python runtime process.
2. The runtime binds `127.0.0.1:<random-port>`.
3. The runtime prints a JSON handshake to stdout: `{"port": ..., "token": ...}`.
4. Tauri caches the connection info and exposes it to the React UI via `runtime_connection`.
5. The React UI uses the bearer token for all REST calls and appends it to the session WebSocket query string.

## Session lifecycle

Sessions move through these states:

- `created`
- `authorized`
- `active`
- `paused`
- `completed`
- `terminated`

Sessions are stored persistently in SQLite. Qingputer does not expire or auto-interrupt sessions on idle time or runtime restart; previously active sessions are restored as reusable `authorized` sessions on startup.

## Agent loop

Each user message triggers a LangGraph state graph:

1. Read recent session state, messages, and events.
2. Ask the provider for one structured `AgentAction`.
3. Evaluate the action through the policy engine.
4. If denied, write a tool result and continue.
5. If approval is required, pause and emit an approval event.
6. If allowed, execute the capability action and append the result as a tool message.
7. If a capability action fails, write an `action_error` tool result and re-plan within a bounded retry budget.
8. Repeat until `final_answer`, approval pause, provider failure, or step limit.

The runtime never exposes raw shell or browser objects to the model.

## Skill integration

Before each provider call, `SessionManager.build_provider_context()` now enriches the model context with local skill metadata:

- Search upward from the session `cwd` for an `AGENTS.md` file.
- If found, parse its `Available skills` registry and resolve the referenced `SKILL.md` files.
- If no `AGENTS.md` is present, fall back to installed skills under `$CODEX_HOME/skills`.
- Select active skills from the latest user message by explicit mention first, then by lightweight name/description matching.
- Inject both the available skill list and the active skill instruction excerpts into `context.skills`.

The provider prompt treats `context.skills.active` as workflow guidance, while still enforcing session grants, policy checks, and the user's latest request.

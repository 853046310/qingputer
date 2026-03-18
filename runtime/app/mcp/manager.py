from __future__ import annotations

import asyncio
import contextlib
import glob
import json
import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.models import (
    McpConnectionStatus,
    McpServerConfig,
    McpServerRuntimeState,
    McpToolDescriptor,
    McpTransport,
)

_PROTOCOL_VERSION = "2025-03-26"
_STDIO_STREAM_LIMIT = 4 * 1024 * 1024


def _path_entries(path_value: str | None) -> list[str]:
    entries: list[str] = []

    def add(entry: str | None) -> None:
        if not entry:
            return
        normalized = entry.strip()
        if not normalized or normalized in entries:
            return
        entries.append(normalized)

    for entry in (path_value or "").split(os.pathsep):
        add(entry)

    home = os.path.expanduser("~")
    common = [
        "/opt/homebrew/bin",
        "/opt/homebrew/opt/node@20/bin",
        "/usr/local/bin",
        os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, ".local", "bin"),
    ]
    for entry in common:
        add(entry)
    for entry in sorted(glob.glob(os.path.join(home, ".nvm", "versions", "node", "*", "bin")), reverse=True):
        add(entry)
    return entries


def _resolve_via_login_shell(command: str) -> tuple[str | None, str | None]:
    if os.name == "nt":
        return None, None
    shell = os.environ.get("SHELL") or "/bin/zsh"
    try:
        command_result = subprocess.run(
            [shell, "-lc", f"command -v {shlex.quote(command)}"],
            capture_output=True,
            text=True,
            check=False,
        )
        path_result = subprocess.run(
            [shell, "-lc", "printf %s \"$PATH\""],
            capture_output=True,
            text=True,
            check=False,
        )
    except Exception:
        return None, None
    resolved = command_result.stdout.strip().splitlines()[0] if command_result.returncode == 0 else None
    shell_path = path_result.stdout.strip() if path_result.returncode == 0 else None
    return resolved or None, shell_path or None


def _resolve_stdio_command(command: str, env: dict[str, str]) -> tuple[str, dict[str, str]]:
    if os.path.sep in command:
        return command, env

    resolved_env = dict(env)
    entries = _path_entries(resolved_env.get("PATH"))
    resolved = shutil.which(command, path=os.pathsep.join(entries))

    if not resolved:
        shell_command, shell_path = _resolve_via_login_shell(command)
        if shell_path:
            entries = _path_entries(shell_path + os.pathsep + os.pathsep.join(entries))
        if shell_command:
            resolved = shell_command

    if resolved:
        entries = _path_entries(os.path.dirname(resolved) + os.pathsep + os.pathsep.join(entries))
        resolved_env["PATH"] = os.pathsep.join(entries)
        return resolved, resolved_env

    resolved_env["PATH"] = os.pathsep.join(entries)
    return command, resolved_env


class McpError(RuntimeError):
    pass


class _BaseMcpClient:
    def __init__(self, config: McpServerConfig) -> None:
        self.config = config
        self.protocol_version = _PROTOCOL_VERSION
        self.server_info: dict[str, Any] | None = None
        self.instructions: str | None = None

    async def initialize(self) -> None:
        result = await self._send_request(
            "initialize",
            {
                "protocolVersion": _PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "Qingputer", "version": "0.1.0"},
            },
        )
        self.protocol_version = str(result.get("protocolVersion") or _PROTOCOL_VERSION)
        self.server_info = result.get("serverInfo") if isinstance(result.get("serverInfo"), dict) else None
        self.instructions = result.get("instructions") if isinstance(result.get("instructions"), str) else None
        await self._send_notification("notifications/initialized", {})

    async def list_tools(self) -> list[McpToolDescriptor]:
        cursor: str | None = None
        tools: list[McpToolDescriptor] = []
        while True:
            params: dict[str, Any] = {}
            if cursor:
                params["cursor"] = cursor
            result = await self._send_request("tools/list", params)
            for raw_tool in result.get("tools", []):
                if not isinstance(raw_tool, dict):
                    continue
                tools.append(
                    McpToolDescriptor(
                        server_id=self.config.server_id,
                        name=str(raw_tool.get("name") or ""),
                        title=raw_tool.get("title") if isinstance(raw_tool.get("title"), str) else None,
                        description=raw_tool.get("description") if isinstance(raw_tool.get("description"), str) else None,
                        input_schema=raw_tool.get("inputSchema") if isinstance(raw_tool.get("inputSchema"), dict) else None,
                    )
                )
            cursor = result.get("nextCursor") if isinstance(result.get("nextCursor"), str) and result.get("nextCursor") else None
            if not cursor:
                break
        return tools

    async def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self._send_request(
            "tools/call",
            {
                "name": tool_name,
                "arguments": arguments,
            },
        )

    async def close(self) -> None:
        return None

    async def _send_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    async def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        raise NotImplementedError


class _StdioMcpClient(_BaseMcpClient):
    def __init__(self, config: McpServerConfig) -> None:
        super().__init__(config)
        self._process: asyncio.subprocess.Process | None = None
        self._request_id = 0
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()
        self.stderr_lines: list[str] = []

    async def start(self) -> None:
        command = (self.config.command or "").strip()
        if not command:
            raise McpError("stdio MCP server requires a command.")
        merged_env = os.environ.copy()
        merged_env.update(self.config.env)
        command, merged_env = _resolve_stdio_command(command, merged_env)
        try:
            self._process = await asyncio.create_subprocess_exec(
                command,
                *self.config.args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.config.cwd or None,
                env=merged_env if merged_env else None,
                limit=_STDIO_STREAM_LIMIT,
            )
        except FileNotFoundError as exc:
            original = (self.config.command or "").strip() or command
            raise McpError(
                f"Unable to start MCP server command '{original}'. "
                "Install Node.js so `npx` is available in your shell, or configure an absolute command path in MCP settings."
            ) from exc
        self._reader_task = asyncio.create_task(self._reader_loop())
        self._stderr_task = asyncio.create_task(self._stderr_loop())

    async def close(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(McpError("MCP stdio connection closed."))
        self._pending.clear()
        for task in (self._reader_task, self._stderr_task):
            if task and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        if self._process:
            if self._process.stdin:
                with contextlib.suppress(Exception):
                    self._process.stdin.close()
            if self._process.returncode is None:
                self._process.terminate()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    self._process.kill()
                    await self._process.wait()

    async def _reader_loop(self) -> None:
        assert self._process and self._process.stdout
        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except json.JSONDecodeError:
                    continue
                await self._handle_message(message)
        finally:
            error = McpError("MCP stdio server disconnected unexpectedly.")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(error)
            self._pending.clear()

    async def _stderr_loop(self) -> None:
        assert self._process and self._process.stderr
        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            if not text:
                continue
            self.stderr_lines.append(text)
            if len(self.stderr_lines) > 50:
                self.stderr_lines = self.stderr_lines[-50:]

    async def _handle_message(self, message: dict[str, Any]) -> None:
        if "id" in message and ("result" in message or "error" in message):
            key = str(message["id"])
            future = self._pending.pop(key, None)
            if future is None or future.done():
                return
            if "error" in message:
                error = message["error"]
                if isinstance(error, dict):
                    detail = error.get("message") or json.dumps(error, ensure_ascii=True)
                else:
                    detail = str(error)
                future.set_exception(McpError(f"MCP request failed: {detail}"))
            else:
                future.set_result(message.get("result") if isinstance(message.get("result"), dict) else {})
            return
        if "method" in message and "id" in message:
            await self._send_payload(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {"code": -32601, "message": "Qingputer does not handle server-initiated requests."},
                }
            )

    async def _send_payload(self, payload: dict[str, Any]) -> None:
        assert self._process and self._process.stdin
        encoded = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"
        async with self._write_lock:
            self._process.stdin.write(encoded.encode("utf-8"))
            await self._process.stdin.drain()

    async def _send_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._request_id += 1
        request_id = str(self._request_id)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self._send_payload(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
        )
        return await future

    async def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params:
            payload["params"] = params
        await self._send_payload(payload)


class _StreamableHttpMcpClient(_BaseMcpClient):
    def __init__(self, config: McpServerConfig) -> None:
        super().__init__(config)
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0))
        self._session_id: str | None = None
        self._request_id = 0

    async def close(self) -> None:
        if self._session_id and self.config.url:
            with contextlib.suppress(Exception):
                await self._client.delete(
                    self.config.url,
                    headers={
                        "MCP-Session-Id": self._session_id,
                        "MCP-Protocol-Version": self.protocol_version,
                    },
                )
        await self._client.aclose()

    async def _send_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._request_id += 1
        request_id = self._request_id
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        return await self._post_request(payload, request_id=request_id)

    async def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params:
            payload["params"] = params
        await self._post_notification(payload)

    async def _post_notification(self, payload: dict[str, Any]) -> None:
        response = await self._client.post(
            self._require_url(),
            headers=self._headers(),
            json=payload,
        )
        if response.status_code >= 400:
            raise McpError(f"MCP HTTP notification failed with status {response.status_code}: {response.text}")

    async def _post_request(self, payload: dict[str, Any], *, request_id: int) -> dict[str, Any]:
        response = await self._client.post(
            self._require_url(),
            headers=self._headers(),
            json=payload,
        )
        if response.status_code == 404 and self._session_id:
            self._session_id = None
            raise McpError("MCP HTTP session expired. Reconnect the server and try again.")
        if response.status_code >= 400:
            raise McpError(f"MCP HTTP request failed with status {response.status_code}: {response.text}")

        session_id = response.headers.get("MCP-Session-Id")
        if session_id:
            self._session_id = session_id

        content_type = response.headers.get("content-type", "")
        if content_type.startswith("application/json"):
            message = response.json()
            return await self._handle_response_message(message, request_id=request_id)
        if content_type.startswith("text/event-stream"):
            return await self._read_sse_response(response, request_id=request_id)
        raise McpError(f"Unsupported MCP HTTP response content type: {content_type or 'unknown'}")

    async def _read_sse_response(self, response: httpx.Response, *, request_id: int) -> dict[str, Any]:
        event_data: list[str] = []
        async for line in response.aiter_lines():
            if line.startswith("data:"):
                event_data.append(line[5:].lstrip())
                continue
            if line == "":
                if not event_data:
                    continue
                message = json.loads("\n".join(event_data))
                event_data.clear()
                if "method" in message and "id" in message:
                    await self._post_notification(
                        {
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "error": {"code": -32601, "message": "Qingputer does not handle server-initiated requests."},
                        }
                    )
                    continue
                if message.get("id") == request_id:
                    return await self._handle_response_message(message, request_id=request_id)
        raise McpError("MCP HTTP stream ended before returning a matching JSON-RPC response.")

    async def _handle_response_message(self, message: dict[str, Any], *, request_id: int) -> dict[str, Any]:
        if message.get("id") != request_id:
            raise McpError("MCP HTTP response returned a mismatched JSON-RPC id.")
        if "error" in message:
            error = message["error"]
            if isinstance(error, dict):
                detail = error.get("message") or json.dumps(error, ensure_ascii=True)
            else:
                detail = str(error)
            raise McpError(f"MCP request failed: {detail}")
        result = message.get("result")
        return result if isinstance(result, dict) else {}

    def _require_url(self) -> str:
        url = (self.config.url or "").strip()
        if not url:
            raise McpError("streamable_http MCP server requires a URL.")
        return url

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if self._session_id:
            headers["MCP-Session-Id"] = self._session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        headers.update(self.config.headers)
        return headers


@dataclass
class _RuntimeState:
    config: McpServerConfig
    client: _BaseMcpClient | None = None
    status: McpConnectionStatus = McpConnectionStatus.DISCONNECTED
    last_error: str | None = None
    tools: list[McpToolDescriptor] = field(default_factory=list)
    server_name: str | None = None
    server_version: str | None = None
    instructions: str | None = None

    def snapshot(self) -> McpServerRuntimeState:
        return McpServerRuntimeState(
            config=self.config,
            status=self.status,
            last_error=self.last_error,
            tools=self.tools,
            server_name=self.server_name,
            server_version=self.server_version,
            instructions=self.instructions,
        )


class McpManager:
    def __init__(self) -> None:
        self._states: dict[str, _RuntimeState] = {}
        self._connect_tasks: dict[str, asyncio.Task[None]] = {}

    async def startup(self, configs: list[McpServerConfig]) -> None:
        await self.sync_servers(configs, background=True)

    async def shutdown(self) -> None:
        for server_id in list(self._connect_tasks):
            await self._cancel_connect_task(server_id)
        for server_id in list(self._states):
            await self.remove_server(server_id)

    async def sync_servers(self, configs: list[McpServerConfig], background: bool = False) -> None:
        desired = {config.server_id: config for config in configs}
        for server_id in list(self._states):
            if server_id not in desired:
                await self.remove_server(server_id)
        for config in configs:
            existing = self._states.get(config.server_id)
            if existing is None:
                existing = _RuntimeState(config=config)
                self._states[config.server_id] = existing
            changed = existing.config.model_dump(mode="json") != config.model_dump(mode="json")
            existing.config = config
            if not config.enabled:
                await self._cancel_connect_task(config.server_id)
                await self._disconnect(existing)
                existing.status = McpConnectionStatus.DISCONNECTED
                existing.last_error = None
                existing.tools = []
                existing.server_name = None
                existing.server_version = None
                existing.instructions = None
                continue
            if changed or existing.client is None:
                if background:
                    self._schedule_connect(existing)
                else:
                    await self._cancel_connect_task(config.server_id)
                    await self._connect(existing)

    async def remove_server(self, server_id: str) -> None:
        await self._cancel_connect_task(server_id)
        state = self._states.pop(server_id, None)
        if state:
            await self._disconnect(state)

    async def refresh_server(self, server_id: str) -> McpServerRuntimeState:
        state = self._require_state(server_id)
        await self._cancel_connect_task(server_id)
        await self._connect(state)
        return state.snapshot()

    def list_states(self) -> list[McpServerRuntimeState]:
        return sorted(
            (state.snapshot() for state in self._states.values()),
            key=lambda item: item.config.name.lower(),
        )

    def tool_context(self) -> dict[str, Any]:
        servers: list[dict[str, Any]] = []
        for state in self._states.values():
            if not state.config.enabled:
                continue
            servers.append(
                {
                    "server_id": state.config.server_id,
                    "name": state.config.name,
                    "transport": state.config.transport.value,
                    "status": state.status.value,
                    "last_error": state.last_error,
                    "tools": [
                        self._tool_summary(tool)
                        for tool in state.tools
                    ],
                }
            )
        return {"servers": servers}

    async def call_tool(self, server_id: str, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        state = self._require_state(server_id)
        if not state.config.enabled:
            raise McpError(f"MCP server {server_id} is disabled.")
        if state.client is None or state.status != McpConnectionStatus.CONNECTED:
            await self._connect(state)
        assert state.client is not None
        return await state.client.call_tool(tool_name, arguments)

    def has_server(self, server_id: str) -> bool:
        return server_id in self._states

    async def _connect(self, state: _RuntimeState) -> None:
        await self._disconnect(state)
        state.status = McpConnectionStatus.CONNECTING
        state.last_error = None
        state.tools = []
        state.server_name = None
        state.server_version = None
        state.instructions = None
        client: _BaseMcpClient | None = None
        try:
            client = self._make_client(state.config)
            if isinstance(client, _StdioMcpClient):
                await client.start()
            await client.initialize()
            state.tools = await client.list_tools()
            state.client = client
            state.status = McpConnectionStatus.CONNECTED
            if client.server_info:
                state.server_name = client.server_info.get("name") if isinstance(client.server_info.get("name"), str) else None
                state.server_version = client.server_info.get("version") if isinstance(client.server_info.get("version"), str) else None
            state.instructions = client.instructions
        except Exception as exc:
            if client is not None:
                with contextlib.suppress(Exception):
                    await client.close()
            state.client = None
            state.status = McpConnectionStatus.ERROR
            state.last_error = str(exc) or type(exc).__name__
            state.tools = []

    async def _disconnect(self, state: _RuntimeState) -> None:
        if state.client is not None:
            await state.client.close()
            state.client = None

    def _schedule_connect(self, state: _RuntimeState) -> None:
        server_id = state.config.server_id
        current = self._connect_tasks.get(server_id)
        if current and not current.done():
            return
        state.status = McpConnectionStatus.CONNECTING
        state.last_error = None

        async def runner() -> None:
            try:
                await self._connect(state)
            finally:
                self._connect_tasks.pop(server_id, None)

        self._connect_tasks[server_id] = asyncio.create_task(runner())

    async def _cancel_connect_task(self, server_id: str) -> None:
        task = self._connect_tasks.pop(server_id, None)
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    @staticmethod
    def _make_client(config: McpServerConfig) -> _BaseMcpClient:
        if config.transport == McpTransport.STDIO:
            return _StdioMcpClient(config)
        if config.transport == McpTransport.STREAMABLE_HTTP:
            return _StreamableHttpMcpClient(config)
        raise McpError(f"Unsupported MCP transport: {config.transport}")

    def _require_state(self, server_id: str) -> _RuntimeState:
        state = self._states.get(server_id)
        if state is None:
            raise McpError(f"Unknown MCP server: {server_id}")
        return state

    @staticmethod
    def _tool_summary(tool: McpToolDescriptor) -> dict[str, Any]:
        schema = tool.input_schema if isinstance(tool.input_schema, dict) else {}
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        required = schema.get("required") if isinstance(schema.get("required"), list) else []
        return {
            "name": tool.name,
            "title": tool.title,
            "description": (tool.description or "")[:200],
            "arguments": list(properties.keys())[:20],
            "required": [str(item) for item in required[:20]],
        }

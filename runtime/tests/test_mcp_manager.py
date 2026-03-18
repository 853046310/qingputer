import textwrap
import asyncio
from pathlib import Path

import pytest

from app.mcp import McpManager
from app.mcp.manager import _resolve_stdio_command
from app.models import (
    McpConnectionStatus,
    McpServerConfig,
    McpTransport,
    default_mcp_servers,
    default_qingflow_mcp_args,
    default_qingflow_mcp_command,
)


def _write_fake_stdio_server(target: Path) -> None:
    target.write_text(
        textwrap.dedent(
            """
            import json
            import sys

            def send(payload):
                sys.stdout.write(json.dumps(payload) + "\\n")
                sys.stdout.flush()

            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                message = json.loads(line)
                method = message.get("method")
                request_id = message.get("id")
                if method == "initialize":
                    send({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": {
                            "protocolVersion": "2025-03-26",
                            "serverInfo": {"name": "Fake MCP", "version": "1.0.0"},
                        },
                    })
                elif method == "tools/list":
                    send({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": {
                            "tools": [
                                {
                                    "name": "echo_tool",
                                    "description": "Echoes the provided text.",
                                    "inputSchema": {
                                        "type": "object",
                                        "properties": {"text": {"type": "string"}},
                                        "required": ["text"],
                                    },
                                }
                            ]
                        },
                    })
                elif method == "tools/call":
                    send({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "result": {
                            "content": [
                                {"type": "text", "text": message.get("params", {}).get("arguments", {}).get("text", "")}
                            ]
                        },
                    })
                elif method == "notifications/initialized":
                    continue
                else:
                    send({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32601, "message": f"Unknown method: {method}"},
                    })
            """
        ),
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_mcp_manager_connects_and_calls_fake_stdio_server(tmp_path: Path) -> None:
    script = tmp_path / "fake_stdio_server.py"
    _write_fake_stdio_server(script)

    manager = McpManager()
    await manager.startup(
        [
            McpServerConfig(
                server_id="fake",
                name="Fake MCP",
                transport=McpTransport.STDIO,
                enabled=True,
                auto_connect=True,
                command="python3",
                args=[str(script)],
            )
        ]
    )
    try:
        states = manager.list_states()
        assert len(states) == 1
        for _ in range(20):
            if states[0].status == McpConnectionStatus.CONNECTED:
                break
            await asyncio.sleep(0.05)
            states = manager.list_states()
        assert states[0].status == McpConnectionStatus.CONNECTED
        assert [tool.name for tool in states[0].tools] == ["echo_tool"]

        result = await manager.call_tool("fake", "echo_tool", {"text": "pong"})
        text = result["content"][0]["text"]
        assert text == "pong"
    finally:
        await manager.shutdown()


def test_default_qingflow_mcp_config_is_enabled() -> None:
    defaults = default_mcp_servers()
    assert len(defaults) == 2
    assert [item.server_id for item in defaults] == ["qingflow-app-user-mcp", "qingflow-app-builder-mcp"]
    assert all(item.enabled is True for item in defaults)
    assert all(item.transport == McpTransport.STDIO for item in defaults)
    assert all(item.command == default_qingflow_mcp_command() for item in defaults)
    assert defaults[0].args == default_qingflow_mcp_args("qingflow-app-user-mcp")
    assert defaults[1].args == default_qingflow_mcp_args("qingflow-app-builder-mcp")


def test_resolve_stdio_command_uses_login_shell_when_path_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str | None]] = []

    def fake_which(command: str, path: str | None = None) -> str | None:
        calls.append((command, path))
        if path and "/Users/test/.volta/bin" in path:
            return "/Users/test/.volta/bin/npx"
        return None

    class FakeCompletedProcess:
        def __init__(self, returncode: int, stdout: str) -> None:
            self.returncode = returncode
            self.stdout = stdout

    def fake_run(args: list[str], **_kwargs: object) -> FakeCompletedProcess:
        script = args[2]
        if script.startswith("command -v "):
            return FakeCompletedProcess(0, "/Users/test/.volta/bin/npx\n")
        if script == 'printf %s "$PATH"':
            return FakeCompletedProcess(0, "/Users/test/.volta/bin:/usr/bin:/bin")
        raise AssertionError(f"unexpected shell command: {script}")

    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr("app.mcp.manager.shutil.which", fake_which)
    monkeypatch.setattr("app.mcp.manager.subprocess.run", fake_run)

    command, env = _resolve_stdio_command("npx", {"PATH": "/usr/bin:/bin"})

    assert command == "/Users/test/.volta/bin/npx"
    assert env["PATH"].split(":")[0] == "/Users/test/.volta/bin"
    assert calls[0][0] == "npx"
    assert "/usr/bin:/bin" in (calls[0][1] or "")
    assert "/Users/test/.volta/bin" in env["PATH"]

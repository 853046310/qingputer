from __future__ import annotations

from app.capabilities.browser import BrowserCapability, BrowserSession
from app.capabilities.filesystem import FilesystemCapability
from app.capabilities.mcp import McpCapability
from app.capabilities.terminal import TerminalCapability, TerminalSession
from app.models import AgentAction, AgentActionKind, EventKind


class CapabilityRouter:
    def __init__(
        self,
        terminal: TerminalCapability,
        filesystem: FilesystemCapability,
        browser: BrowserCapability,
        mcp: McpCapability,
    ) -> None:
        self._terminal = terminal
        self._filesystem = filesystem
        self._browser = browser
        self._mcp = mcp

    async def execute(
        self,
        action: AgentAction,
        *,
        terminal_session: TerminalSession,
        browser_session: BrowserSession,
        on_terminal_output,
    ) -> tuple[dict[str, object], EventKind]:
        if action.kind == AgentActionKind.TERMINAL_RUN:
            result = await self._terminal.run_command(
                terminal_session,
                action.args["command"],
                on_output=on_terminal_output,
                cwd=action.args.get("cwd"),
                env_overrides=action.args.get("env_overrides"),
                timeout_sec=action.args.get("timeout_sec"),
            )
            result["cwd"] = terminal_session.cwd
            return result, EventKind.COMMAND_FINISHED
        if action.kind == AgentActionKind.TERMINAL_KILL:
            return await self._terminal.kill_process(terminal_session), EventKind.COMMAND_FINISHED
        if action.kind == AgentActionKind.FILESYSTEM_READ:
            return (
                self._filesystem.read_file(
                    action.args["path"],
                    encoding=action.args.get("encoding", "utf8"),
                ),
                EventKind.FILE_READ,
            )
        if action.kind == AgentActionKind.FILESYSTEM_WRITE:
            return (
                self._filesystem.write_file(
                    action.args["path"],
                    action.args["content"],
                    encoding=action.args.get("encoding", "utf8"),
                    mode=action.args.get("mode", "overwrite"),
                ),
                EventKind.FILE_WRITE,
            )
        if action.kind == AgentActionKind.FILESYSTEM_LIST:
            return self._filesystem.list_directory(action.args["path"]), EventKind.FILE_LIST
        if action.kind == AgentActionKind.BROWSER_OPEN:
            return await self._browser.open_page(browser_session, action.args["url"]), EventKind.BROWSER_NAV
        if action.kind == AgentActionKind.BROWSER_CLICK:
            return await self._browser.click(browser_session, action.args["selector"]), EventKind.BROWSER_ACTION
        if action.kind == AgentActionKind.BROWSER_TYPE:
            return (
                await self._browser.type_text(
                    browser_session,
                    action.args["selector"],
                    action.args["text"],
                    clear=action.args.get("clear", True),
                ),
                EventKind.BROWSER_ACTION,
            )
        if action.kind == AgentActionKind.BROWSER_EXTRACT:
            return (
                await self._browser.extract_text(browser_session, action.args.get("selector")),
                EventKind.BROWSER_ACTION,
            )
        if action.kind == AgentActionKind.MCP_CALL:
            return (
                await self._mcp.call_tool(
                    str(action.args["server_id"]),
                    str(action.args["tool_name"]),
                    action.args.get("arguments", {}),
                ),
                EventKind.MCP_CALL,
            )
        raise NotImplementedError(f"Capability router does not handle action kind {action.kind}.")

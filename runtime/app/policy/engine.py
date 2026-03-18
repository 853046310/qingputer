from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.config import AppConfig
from app.models import ApprovalMode, AgentAction, AgentActionKind, PolicyDecision, PolicyVerdict, RiskLevel, SessionRecord


@dataclass(slots=True)
class PolicyContext:
    session: SessionRecord


class PolicyEngine:
    DENY_COMMAND_PATTERNS = (
        re.compile(r"\brm\s+-rf\s+/(\s|$)"),
        re.compile(r"\bshutdown\b"),
        re.compile(r"\breboot\b"),
        re.compile(r"\bdiskutil\s+eraseDisk\b"),
        re.compile(r"\bmkfs\.\w+\b"),
        re.compile(r"\bdd\s+.*\bof=/dev/"),
        re.compile(r":\(\)\s*\{\s*:\|:&\s*;\s*}"),
    )
    APPROVAL_COMMAND_PATTERNS = (
        re.compile(r"\bsudo\b"),
        re.compile(r"\brm\b"),
        re.compile(r"\bmv\b"),
        re.compile(r"\bchmod\b"),
        re.compile(r"\bchown\b"),
        re.compile(r"\blaunchctl\b"),
        re.compile(r"\bosascript\b"),
        re.compile(r"\bpip(?:3)?\s+install\b"),
        re.compile(r"\bnpm\s+(?:install|publish)\b"),
        re.compile(r"\bbrew\s+(?:install|upgrade)\b"),
        re.compile(r"\bgit\s+push\b"),
        re.compile(r"(?:^|[;&|])\s*curl\s+.*(?:-o|--output)\b"),
        re.compile(r"(?:^|[;&|])\s*wget\b"),
        re.compile(r">>?\s*"),
        re.compile(r"\bnohup\b"),
        re.compile(r"(?:^|[^&])&(?!&)"),
    )
    READ_ONLY_COMMAND_PATTERNS = (
        re.compile(r"^\s*pwd\s*$"),
        re.compile(r"^\s*ls(?:\s+.+)?$"),
        re.compile(r"^\s*cat\s+.+$"),
        re.compile(r"^\s*git\s+status(?:\s+.+)?$"),
        re.compile(r"^\s*python(?:3)?\s+--version\s*$"),
        re.compile(r"^\s*which\s+.+$"),
        re.compile(r"^\s*echo\s+.+$"),
    )
    def __init__(self, config: AppConfig) -> None:
        self._config = config
        self._sensitive_paths = tuple(
            path.resolve()
            for path in (
                config.home_directory / ".ssh",
                config.home_directory / ".gnupg",
                config.home_directory / "Library" / "Keychains",
                config.home_directory / "Library" / "Mail",
                config.home_directory / "Library" / "Messages",
                config.home_directory / "Library" / "Application Support" / "Google" / "Chrome",
                config.home_directory / "Library" / "Safari",
            )
        )

    def evaluate(self, context: PolicyContext, action: AgentAction) -> PolicyDecision:
        session = context.session
        approval_mode = ApprovalMode.normalize(session.config.approval_mode.value if isinstance(session.config.approval_mode, ApprovalMode) else session.config.approval_mode)
        if action.kind in {
            AgentActionKind.TERMINAL_RUN,
            AgentActionKind.TERMINAL_KILL,
        } and not session.config.grants.terminal:
            return self._deny("Terminal capability is not granted for this session.")
        if action.kind in {
            AgentActionKind.FILESYSTEM_READ,
            AgentActionKind.FILESYSTEM_WRITE,
            AgentActionKind.FILESYSTEM_LIST,
        } and not session.config.grants.filesystem:
            return self._deny("Filesystem capability is not granted for this session.")
        if action.kind in {
            AgentActionKind.BROWSER_OPEN,
            AgentActionKind.BROWSER_CLICK,
            AgentActionKind.BROWSER_TYPE,
            AgentActionKind.BROWSER_EXTRACT,
        } and not session.config.grants.browser:
            return self._deny("Browser capability is not granted for this session.")

        if action.kind == AgentActionKind.FINAL_ANSWER:
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.LOW,
                reason="Assistant final answers do not require policy review.",
            )
        if action.kind == AgentActionKind.MCP_CALL:
            return self._evaluate_mcp_action(action, approval_mode)
        if action.kind in {
            AgentActionKind.BROWSER_OPEN,
            AgentActionKind.BROWSER_CLICK,
            AgentActionKind.BROWSER_TYPE,
            AgentActionKind.BROWSER_EXTRACT,
        }:
            return self._evaluate_browser_action(action)

        if approval_mode == ApprovalMode.DEFAULT:
            return self._require_default_approval(action)
        if approval_mode == ApprovalMode.MAXIMUM:
            return self._allow_maximum_access(action)

        if action.kind == AgentActionKind.TERMINAL_RUN:
            return self._evaluate_command(action.args.get("command", ""))
        if action.kind == AgentActionKind.TERMINAL_KILL:
            return self._allow_terminal_kill()
        if action.kind in {
            AgentActionKind.FILESYSTEM_READ,
            AgentActionKind.FILESYSTEM_LIST,
            AgentActionKind.FILESYSTEM_WRITE,
        }:
            return self._evaluate_path_action(action)
        if action.kind in {
            AgentActionKind.BROWSER_OPEN,
            AgentActionKind.BROWSER_CLICK,
            AgentActionKind.BROWSER_TYPE,
            AgentActionKind.BROWSER_EXTRACT,
        }:
            return self._evaluate_browser_action(action)
        return self._deny("Action kind is not implemented by the runtime.")

    def _require_default_approval(self, action: AgentAction) -> PolicyDecision:
        if action.kind == AgentActionKind.TERMINAL_RUN:
            command = str(action.args.get("command", ""))
            if not command.strip():
                return self._deny("Terminal commands require a non-empty command string.")
            return self._approval("Default permission mode requires approval before running terminal commands.", RiskLevel.MEDIUM)
        if action.kind == AgentActionKind.TERMINAL_KILL:
            return self._approval("Default permission mode requires approval before interrupting a terminal command.", RiskLevel.MEDIUM)
        if action.kind in {
            AgentActionKind.FILESYSTEM_READ,
            AgentActionKind.FILESYSTEM_LIST,
            AgentActionKind.FILESYSTEM_WRITE,
        }:
            if not str(action.args.get("path", "")).strip():
                return self._deny("Filesystem actions require a target path.")
            return self._approval("Default permission mode requires approval before filesystem access.", RiskLevel.MEDIUM)
        if action.kind == AgentActionKind.MCP_CALL:
            if not str(action.args.get("server_id", "")).strip() or not str(action.args.get("tool_name", "")).strip():
                return self._deny("MCP calls require both server_id and tool_name.")
            return self._approval("Default permission mode requires approval before calling MCP tools.", RiskLevel.MEDIUM)
        return self._deny("Action kind is not implemented by the runtime.")

    def _allow_maximum_access(self, action: AgentAction) -> PolicyDecision:
        if action.kind == AgentActionKind.TERMINAL_RUN:
            command = str(action.args.get("command", ""))
            if not command.strip():
                return self._deny("Terminal commands require a non-empty command string.")
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.CRITICAL,
                reason="Maximum access mode auto-allows terminal commands without approval.",
            )
        if action.kind == AgentActionKind.TERMINAL_KILL:
            return self._allow_terminal_kill()
        if action.kind in {
            AgentActionKind.FILESYSTEM_READ,
            AgentActionKind.FILESYSTEM_LIST,
            AgentActionKind.FILESYSTEM_WRITE,
        }:
            if not str(action.args.get("path", "")).strip():
                return self._deny("Filesystem actions require a target path.")
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.HIGH,
                reason="Maximum access mode auto-allows filesystem access without approval.",
            )
        if action.kind == AgentActionKind.MCP_CALL:
            if not str(action.args.get("server_id", "")).strip() or not str(action.args.get("tool_name", "")).strip():
                return self._deny("MCP calls require both server_id and tool_name.")
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.HIGH,
                reason="Maximum access mode auto-allows MCP tool calls without approval.",
            )
        return self._deny("Action kind is not implemented by the runtime.")

    def _evaluate_command(self, command: str) -> PolicyDecision:
        for pattern in self.DENY_COMMAND_PATTERNS:
            if pattern.search(command):
                return self._deny("Command matches a destructive shell pattern.", RiskLevel.CRITICAL)
        for pattern in self.APPROVAL_COMMAND_PATTERNS:
            if pattern.search(command):
                return self._approval("Command may mutate the system or perform a privileged action.", RiskLevel.HIGH)
        for pattern in self.READ_ONLY_COMMAND_PATTERNS:
            if pattern.search(command):
                return PolicyDecision(
                    verdict=PolicyVerdict.ALLOW,
                    risk_level=RiskLevel.LOW,
                    reason="Command matches the read-only command allow-list.",
                )
        return PolicyDecision(
            verdict=PolicyVerdict.ALLOW,
            risk_level=RiskLevel.MEDIUM,
            reason="Command runs inside an already authorized session and does not match elevated-risk patterns.",
        )

    @staticmethod
    def _allow_terminal_kill() -> PolicyDecision:
        return PolicyDecision(
            verdict=PolicyVerdict.ALLOW,
            risk_level=RiskLevel.MEDIUM,
            reason="Interrupting the active PTY command is allowed inside an authorized session.",
        )

    def _evaluate_path_action(self, action: AgentAction) -> PolicyDecision:
        raw_path = str(action.args.get("path", ""))
        if not raw_path:
            return self._deny("Filesystem actions require a target path.")
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = (Path(action.args.get("cwd") or self._config.home_directory) / path).resolve()
        else:
            path = path.resolve()

        inside_home = self._is_within(path, self._config.home_directory.resolve())
        sensitive = any(self._is_within(path, candidate) for candidate in self._sensitive_paths)
        if action.kind == AgentActionKind.FILESYSTEM_WRITE:
            if sensitive or not inside_home:
                return self._approval("Writing outside the default Home boundary or into a sensitive path requires approval.", RiskLevel.HIGH)
            return self._approval("Filesystem writes always require a human approval in v1.", RiskLevel.MEDIUM)
        if sensitive or not inside_home:
            return self._approval("Reading outside the default Home boundary or from a sensitive path requires approval.", RiskLevel.HIGH)
        return PolicyDecision(
            verdict=PolicyVerdict.ALLOW,
            risk_level=RiskLevel.LOW,
            reason="Filesystem read/list stays inside the default Home boundary.",
        )

    def _evaluate_browser_action(self, action: AgentAction) -> PolicyDecision:
        if action.kind == AgentActionKind.BROWSER_OPEN:
            url = str(action.args.get("url", ""))
            if not url.startswith(("http://", "https://")):
                return self._deny("Browser open only supports http(s) URLs in v1.")
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.LOW,
                reason="Browser navigation executes directly without approval in the isolated browser session.",
            )
        if action.kind == AgentActionKind.BROWSER_EXTRACT:
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.LOW,
                reason="Browser extraction executes directly without approval in the isolated browser session.",
            )
        return PolicyDecision(
            verdict=PolicyVerdict.ALLOW,
            risk_level=RiskLevel.MEDIUM,
            reason="Browser interaction executes directly without approval in the isolated Chromium profile.",
        )

    def _evaluate_mcp_action(self, action: AgentAction, approval_mode: ApprovalMode) -> PolicyDecision:
        server_id = str(action.args.get("server_id", "")).strip()
        tool_name = str(action.args.get("tool_name", "")).strip()
        if not server_id or not tool_name:
            return self._deny("MCP calls require both server_id and tool_name.")
        if approval_mode == ApprovalMode.MAXIMUM:
            return PolicyDecision(
                verdict=PolicyVerdict.ALLOW,
                risk_level=RiskLevel.HIGH,
                reason="Maximum access mode auto-allows MCP tool calls without approval.",
            )
        return self._approval(
            f"MCP tool call {server_id}:{tool_name} requires approval in this permission mode.",
            RiskLevel.MEDIUM,
        )

    @staticmethod
    def _is_within(path: Path, candidate: Path) -> bool:
        try:
            path.relative_to(candidate)
            return True
        except ValueError:
            return False

    @staticmethod
    def _deny(reason: str, risk_level: RiskLevel = RiskLevel.HIGH) -> PolicyDecision:
        return PolicyDecision(verdict=PolicyVerdict.DENY, risk_level=risk_level, reason=reason)

    @staticmethod
    def _approval(reason: str, risk_level: RiskLevel = RiskLevel.HIGH) -> PolicyDecision:
        return PolicyDecision(
            verdict=PolicyVerdict.REQUIRE_APPROVAL,
            risk_level=risk_level,
            reason=reason,
        )

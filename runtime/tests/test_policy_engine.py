from pathlib import Path

from app.config import AppConfig
from app.models import ApprovalMode, AgentAction, AgentActionKind, AgentSessionConfig, CapabilityGrants, SessionRecord
from app.policy import PolicyContext, PolicyEngine


def make_session(home: Path, approval_mode: ApprovalMode = ApprovalMode.DEFAULT) -> SessionRecord:
    config = AgentSessionConfig(
        cwd=str(home),
        grants=CapabilityGrants(terminal=True, filesystem=True, browser=True),
        approval_mode=approval_mode,
    )
    return SessionRecord(config=config, current_cwd=str(home))


def test_default_mode_requires_approval_for_read_only_command(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path)),
        AgentAction(kind=AgentActionKind.TERMINAL_RUN, args={"command": "pwd"}),
    )
    assert decision.verdict.value == "require_approval"


def test_legacy_risk_mode_denies_destructive_command(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.LEGACY_RISK_BASED)),
        AgentAction(kind=AgentActionKind.TERMINAL_RUN, args={"command": "rm -rf /"}),
    )
    assert decision.verdict.value == "deny"


def test_legacy_risk_mode_filesystem_write_requires_approval(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.LEGACY_RISK_BASED)),
        AgentAction(kind=AgentActionKind.FILESYSTEM_WRITE, args={"path": str(tmp_path / "note.txt"), "content": "hello"}),
    )
    assert decision.verdict.value == "require_approval"


def test_maximum_mode_auto_allows_destructive_command(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.MAXIMUM)),
        AgentAction(kind=AgentActionKind.TERMINAL_RUN, args={"command": "rm -rf /tmp/demo"}),
    )
    assert decision.verdict.value == "allow"


def test_browser_navigation_is_allowed_without_approval_in_default_mode(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.DEFAULT)),
        AgentAction(kind=AgentActionKind.BROWSER_OPEN, args={"url": "https://example.com"}),
    )
    assert decision.verdict.value == "allow"


def test_browser_click_is_allowed_without_approval_in_legacy_mode(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.LEGACY_RISK_BASED)),
        AgentAction(kind=AgentActionKind.BROWSER_CLICK, args={"selector": "text=登录"}),
    )
    assert decision.verdict.value == "allow"


def test_default_mode_requires_approval_for_mcp_calls(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.DEFAULT)),
        AgentAction(kind=AgentActionKind.MCP_CALL, args={"server_id": "qingflow-mcp", "tool_name": "workspace_list", "arguments": {}}),
    )
    assert decision.verdict.value == "require_approval"


def test_maximum_mode_allows_mcp_calls(tmp_path: Path) -> None:
    engine = PolicyEngine(AppConfig(home_directory=tmp_path))
    decision = engine.evaluate(
        PolicyContext(session=make_session(tmp_path, approval_mode=ApprovalMode.MAXIMUM)),
        AgentAction(kind=AgentActionKind.MCP_CALL, args={"server_id": "qingflow-mcp", "tool_name": "workspace_list", "arguments": {}}),
    )
    assert decision.verdict.value == "allow"

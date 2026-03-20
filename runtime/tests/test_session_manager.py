from pathlib import Path

import pytest

from app.config import AppConfig
from app.models import (
    AgentSessionConfig,
    ApprovalMode,
    CapabilityGrants,
    McpConnectionStatus,
    McpServerConfig,
    McpTransport,
    MessageRole,
    QingflowAuthStatus,
    QingflowMcpSyncState,
)
from app.session import SessionManager


def make_config(home: Path) -> AgentSessionConfig:
    return AgentSessionConfig(
        cwd=str(home),
        grants=CapabilityGrants(terminal=True, filesystem=True, browser=True),
        approval_mode=ApprovalMode.DEFAULT,
    )


def write_skill(path: Path, *, name: str, description: str, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_session_manager_supports_list_update_delete(tmp_path: Path) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    await manager.startup()
    try:
        first = await manager.create_session(make_config(tmp_path), title="First Session")
        second = await manager.create_session(make_config(tmp_path), title="Second Session")

        sessions = manager.list_sessions()
        assert {item.session_id for item in sessions} == {first.session_id, second.session_id}

        updated = await manager.update_session(
            first.session_id,
            title="Renamed Session",
            approval_mode=ApprovalMode.MAXIMUM,
        )
        assert updated.title == "Renamed Session"
        assert updated.config.approval_mode == ApprovalMode.MAXIMUM

        await manager.delete_session(second.session_id)

        remaining = manager.list_sessions()
        assert [item.session_id for item in remaining] == [first.session_id]
        assert manager.database.get_session(second.session_id) is None
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_post_message_requires_provider_configuration(tmp_path: Path) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    await manager.startup()
    try:
        manager.secret_store.delete_openai_api_key()
        session = await manager.create_session(make_config(tmp_path), title="No Key")
        with pytest.raises(RuntimeError) as exc_info:
            await manager.post_user_message(session.session_id, "hello")
        assert "API key" in str(exc_info.value)
        assert manager.database.list_messages(session.session_id) == []
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_startup_migrates_legacy_qingflow_mcp_to_split_servers(tmp_path: Path) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    manager.database.initialize()
    settings = manager.database.load_settings()
    settings.mcp_servers = [
        McpServerConfig(
            server_id="qingflow-mcp",
            name="Qingflow MCP",
            transport=McpTransport.STDIO,
            enabled=True,
            auto_connect=True,
            command="/Users/yanqidong/Documents/qingflow-next/qingflow-support/mcp-server/qingflow-mcp",
            args=[],
            env={"QINGFLOW_MCP_DEFAULT_BASE_URL": "https://qingflow.com/api"},
        )
    ]
    manager.database.save_settings(settings)

    await manager.startup()
    try:
        migrated = manager.get_settings().mcp_servers
        assert [server.server_id for server in migrated] == ["qingflow-app-user-mcp", "qingflow-app-builder-mcp"]
        assert all(server.command == "npx" for server in migrated)
        assert migrated[0].args == ["-y", "@josephyan/qingflow-app-user-mcp@0.2.0-beta.6"]
        assert migrated[1].args == ["-y", "@josephyan/qingflow-app-builder-mcp@0.2.0-beta.6"]
        assert all(server.env["QINGFLOW_MCP_DEFAULT_BASE_URL"] == "https://qingflow.com/api" for server in migrated)
    finally:
        await manager.shutdown()


def test_get_settings_checks_key_presence_without_secret_lookup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    manager.database.initialize()

    def fail_secret_lookup() -> None:
        raise AssertionError("unexpected secret lookup")

    monkeypatch.setattr(manager.secret_store, "get_openai_api_key", fail_secret_lookup)
    monkeypatch.setattr(manager.secret_store, "get_openrouter_api_key", fail_secret_lookup)
    monkeypatch.setattr(manager.secret_store, "has_openai_api_key", lambda: True)
    monkeypatch.setattr(manager.secret_store, "has_openrouter_api_key", lambda: False)

    loaded = manager.get_settings()

    assert loaded.openai_api_key_set is True
    assert loaded.openrouter_api_key_set is False


def test_update_and_delete_settings_persist_api_key_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    manager.database.initialize()
    saved_keys: list[str] = []
    saved_openrouter_keys: list[str] = []
    deleted_keys: list[bool] = []
    deleted_openrouter_keys: list[bool] = []

    monkeypatch.setattr(manager.secret_store, "set_openai_api_key", lambda value: saved_keys.append(value))
    monkeypatch.setattr(manager.secret_store, "set_openrouter_api_key", lambda value: saved_openrouter_keys.append(value))
    updated = manager.update_settings(openai_api_key="sk-test", model_provider="openrouter", openrouter_api_key="sk-or-test")

    assert saved_keys == ["sk-test"]
    assert saved_openrouter_keys == ["sk-or-test"]
    assert updated.openai_api_key_set is True
    assert updated.openrouter_api_key_set is True
    assert updated.model_provider == "openrouter"
    assert manager.database.load_settings().openai_api_key_set is True
    assert manager.database.load_settings().openrouter_api_key_set is True

    updated = manager.update_settings(
        qingflow_web_origin="https://example.qingflow.com/",
        qingflow_api_base_url="https://example.qingflow.com/api/",
    )
    assert updated.qingflow_web_origin == "https://example.qingflow.com"
    assert updated.qingflow_api_base_url == "https://example.qingflow.com/api"
    assert manager.database.load_settings().qingflow_web_origin == "https://example.qingflow.com"
    assert manager.database.load_settings().qingflow_api_base_url == "https://example.qingflow.com/api"

    monkeypatch.setattr(manager.secret_store, "delete_openai_api_key", lambda: deleted_keys.append(True))
    monkeypatch.setattr(manager.secret_store, "delete_openrouter_api_key", lambda: deleted_openrouter_keys.append(True))
    deleted = manager.delete_api_key("openrouter")

    assert deleted_keys == []
    assert deleted_openrouter_keys == [True]
    assert deleted.openrouter_api_key_set is False
    assert manager.database.load_settings().openrouter_api_key_set is False

    deleted = manager.delete_api_key("openai")
    assert deleted_keys == [True]
    assert deleted.openai_api_key_set is False
    assert manager.database.load_settings().openai_api_key_set is False


@pytest.mark.asyncio
async def test_build_provider_context_includes_active_skills(tmp_path: Path) -> None:
    codex_home = tmp_path / ".codex"
    skill_path = codex_home / "skills" / "qingflow-app-builder" / "SKILL.md"
    write_skill(
        skill_path,
        name="qingflow-app-builder",
        description="Build and modify Qingflow apps",
        body="# Builder\nUse builder MCP tools.",
    )
    (tmp_path / "AGENTS.md").write_text(
        f"## Skills\n### Available skills\n- qingflow-app-builder: Build and modify Qingflow apps. (file: {skill_path})\n",
        encoding="utf-8",
    )

    manager = SessionManager(
        AppConfig(
            home_directory=tmp_path,
            codex_home_directory=codex_home,
            enable_default_mcp_servers=False,
        )
    )
    await manager.startup()
    try:
        session = await manager.create_session(make_config(tmp_path), title="Skill Context")
        await manager.add_message(session.session_id, role=MessageRole.USER, content="请用 qingflow-app-builder 帮我改轻流表单。")
        context = manager.build_provider_context(session.session_id)

        assert context["skills"]["agents_path"] == str(tmp_path / "AGENTS.md")
        assert [item["name"] for item in context["skills"]["active"]] == ["qingflow-app-builder"]
        assert "Use builder MCP tools." in context["skills"]["active"][0]["instructions_excerpt"]
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_build_provider_context_includes_qingflow_profile_hints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    await manager.startup()
    try:
        session = await manager.create_session(make_config(tmp_path), title="Qingflow Context")
        monkeypatch.setattr(manager.secret_store, "has_qingflow_api_token", lambda: True)
        manager.qingflow_auth._status = QingflowAuthStatus(
            token_set=True,
            connected=True,
            user_name="严琦东",
            user_email="yanqidong@exiao.tech",
            selected_ws_id=140653,
            selected_ws_name="开放平台正式版工作区",
            mcp_sync=QingflowMcpSyncState(
                builder_status=McpConnectionStatus.CONNECTED,
                user_status=McpConnectionStatus.CONNECTED,
            ),
        )

        context = manager.build_provider_context(session.session_id)

        assert context["qingflow"]["selected_ws_id"] == 140653
        assert context["qingflow"]["profile_hints"]["qingflow-app-builder-mcp"]["preferred_profile"] == "default"
        assert context["qingflow"]["profile_hints"]["qingflow-app-user-mcp"]["preferred_profile"] == "default"
    finally:
        await manager.shutdown()

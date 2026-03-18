from pathlib import Path

import pytest

from app.config import AppConfig
from app.models import AgentSessionConfig, ApprovalMode, CapabilityGrants, McpServerConfig, McpTransport
from app.session import SessionManager


def make_config(home: Path) -> AgentSessionConfig:
    return AgentSessionConfig(
        cwd=str(home),
        grants=CapabilityGrants(terminal=True, filesystem=True, browser=True),
        approval_mode=ApprovalMode.DEFAULT,
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
        assert migrated[0].args == ["-y", "@josephyan/qingflow-app-user-mcp@0.1.0-beta.9"]
        assert migrated[1].args == ["-y", "@josephyan/qingflow-app-builder-mcp@0.1.0-beta.12"]
        assert all(server.env["QINGFLOW_MCP_DEFAULT_BASE_URL"] == "https://qingflow.com/api" for server in migrated)
    finally:
        await manager.shutdown()


def test_get_settings_checks_key_presence_without_secret_lookup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    manager.database.initialize()

    def fail_secret_lookup() -> None:
        raise AssertionError("unexpected secret lookup")

    monkeypatch.setattr(manager.secret_store, "get_openai_api_key", fail_secret_lookup)
    monkeypatch.setattr(manager.secret_store, "has_openai_api_key", lambda: True)

    loaded = manager.get_settings()

    assert loaded.openai_api_key_set is True


def test_update_and_delete_settings_persist_api_key_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SessionManager(AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False))
    manager.database.initialize()
    saved_keys: list[str] = []
    deleted_keys: list[bool] = []

    monkeypatch.setattr(manager.secret_store, "set_openai_api_key", lambda value: saved_keys.append(value))
    updated = manager.update_settings(openai_api_key="sk-test")

    assert saved_keys == ["sk-test"]
    assert updated.openai_api_key_set is True
    assert manager.database.load_settings().openai_api_key_set is True

    monkeypatch.setattr(manager.secret_store, "delete_openai_api_key", lambda: deleted_keys.append(True))
    deleted = manager.delete_openai_api_key()

    assert deleted_keys == [True]
    assert deleted.openai_api_key_set is False
    assert manager.database.load_settings().openai_api_key_set is False

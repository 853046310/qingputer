from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.config import AppConfig
from app.models import McpConnectionStatus, QingflowAuthStatus, QingflowMcpSyncState, default_mcp_servers
from app.qingflow import QingflowAuthManager
from app.models.schemas import (
    QINGFLOW_APP_BUILDER_MCP_SERVER_ID,
    QINGFLOW_APP_USER_MCP_SERVER_ID,
)
from app.storage import Database, SecretStore


class FakeMcpManager:
    def __init__(self, *, fail_server_id: str | None = None) -> None:
        self.fail_server_id = fail_server_id
        self.server_ids: set[str] = set()
        self.refreshes: list[str] = []
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    async def sync_servers(self, configs, background: bool = False) -> None:  # type: ignore[no-untyped-def]
        self.server_ids = {config.server_id for config in configs}

    async def refresh_server(self, server_id: str):  # type: ignore[no-untyped-def]
        self.refreshes.append(server_id)
        return None

    async def call_tool(self, server_id: str, tool_name: str, arguments: dict[str, object]) -> dict[str, object]:
        self.calls.append((server_id, tool_name, arguments))
        if self.fail_server_id == server_id and tool_name == "auth_use_token":
            raise RuntimeError("forced MCP sync failure")
        return {}

    def has_server(self, server_id: str) -> bool:
        return server_id in self.server_ids


def build_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    fail_server_id: str | None = None,
) -> tuple[QingflowAuthManager, Database, FakeMcpManager, dict[str, str | None]]:
    config = AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False)
    config.support_directory.mkdir(parents=True, exist_ok=True)
    database = Database(config.database_path)
    database.initialize()
    settings = database.load_settings()
    settings.mcp_servers = default_mcp_servers()
    database.save_settings(settings)

    secret_store = SecretStore(config)
    token_slot: dict[str, str | None] = {"value": None}
    monkeypatch.setattr(secret_store, "set_qingflow_api_token", lambda token: token_slot.__setitem__("value", token))
    monkeypatch.setattr(secret_store, "get_qingflow_api_token", lambda: token_slot["value"])
    monkeypatch.setattr(secret_store, "has_qingflow_api_token", lambda: token_slot["value"] is not None)
    monkeypatch.setattr(secret_store, "delete_qingflow_api_token", lambda: token_slot.__setitem__("value", None))

    mcp = FakeMcpManager(fail_server_id=fail_server_id)
    manager = QingflowAuthManager(config, database, secret_store, mcp)  # type: ignore[arg-type]
    return manager, database, mcp, token_slot


@pytest.mark.asyncio
async def test_startup_keeps_saved_token_but_requires_fresh_login(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, database, _mcp, token_slot = build_manager(tmp_path, monkeypatch)
    settings = database.load_settings()
    settings.qingflow_user_name = "Tester"
    settings.qingflow_user_email = "tester@example.com"
    settings.qingflow_user_avatar_url = "https://cdn.example.com/avatar.png"
    settings.qingflow_selected_ws_id = 40013
    settings.qingflow_selected_ws_name = "轻流"
    database.save_settings(settings)
    token_slot["value"] = "saved-token"

    await manager.startup()
    status = manager.get_status()

    assert status.token_set is True
    assert status.connected is False
    assert status.user_email == "tester@example.com"
    assert status.user_avatar_url == "https://cdn.example.com/avatar.png"
    assert status.selected_ws_id == 40013


@pytest.mark.asyncio
async def test_refresh_status_backfills_missing_avatar_from_user_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, database, _mcp, token_slot = build_manager(tmp_path, monkeypatch)
    settings = database.load_settings()
    settings.qingflow_user_name = "Tester"
    settings.qingflow_user_email = "tester@example.com"
    settings.qingflow_user_avatar_url = None
    database.save_settings(settings)
    token_slot["value"] = "saved-token"

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
    ):
        assert token == "saved-token"
        assert ws_id is None
        if path == "/user":
            return {
                "nickName": "Tester",
                "email": "tester@example.com",
                "headImg": "//cdn.example.com/avatar.png",
            }
        raise AssertionError(f"unexpected path: {path}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    status = await manager.refresh_status()
    saved_settings = database.load_settings()

    assert status.user_avatar_url == "https://cdn.example.com/avatar.png"
    assert saved_settings.qingflow_user_avatar_url == "https://cdn.example.com/avatar.png"


@pytest.mark.asyncio
async def test_connect_requires_manual_workspace_selection_even_with_detected_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, database, mcp, token_slot = build_manager(tmp_path, monkeypatch)
    settings = database.load_settings()
    settings.qingflow_selected_ws_id = 101
    settings.qingflow_selected_ws_name = "Detected"
    database.save_settings(settings)

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {
                "nickName": "Tester",
                "email": "tester@example.com",
                "headImg": "https://cdn.example.com/avatar.png",
                "lastWsInfo": {"wsId": 202},
            }
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Detected"}, {"wsId": 202, "wsName": "Last"}]
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    status = await manager.connect("qf-token", detected_ws_id=101)
    await asyncio.sleep(0)
    status = manager.get_status()

    assert token_slot["value"] == "qf-token"
    assert status.connected is False
    assert status.selected_ws_id is None
    assert status.selected_ws_name is None
    assert status.requires_workspace_selection is True
    assert status.requires_workspace_creation is False
    assert status.user_name == "Tester"
    assert status.user_email == "tester@example.com"
    assert status.user_avatar_url == "https://cdn.example.com/avatar.png"
    assert status.workspaces[0].ws_id == 101
    assert status.mcp_sync.builder_status == McpConnectionStatus.DISCONNECTED
    assert status.mcp_sync.user_status == McpConnectionStatus.DISCONNECTED
    assert mcp.calls == []


@pytest.mark.asyncio
async def test_select_workspace_connects_after_manual_confirmation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, _token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com", "lastWsInfo": {"wsId": 202}}
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Detected"}, {"wsId": 202, "wsName": "Last"}]
        if path == "/ws/change":
            assert json_body == {"wsId": 202}
            return {"wsId": 202, "workspaceName": "Last"}
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    initial = await manager.connect("qf-token")
    assert initial.connected is False

    status = await manager.select_workspace(202)
    await asyncio.sleep(0)
    status = manager.get_status()

    assert status.connected is True
    assert status.selected_ws_id == 202
    assert status.selected_ws_name == "Last"


@pytest.mark.asyncio
async def test_connect_requires_workspace_selection_when_multiple_exist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com"}
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Alpha"}, {"wsId": 202, "wsName": "Beta"}]
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    status = await manager.connect("qf-token")

    assert token_slot["value"] == "qf-token"
    assert status.connected is False
    assert status.requires_workspace_selection is True
    assert status.requires_workspace_creation is False
    assert status.selected_ws_id is None
    assert [workspace.ws_id for workspace in status.workspaces] == [101, 202]


@pytest.mark.asyncio
async def test_connect_requires_workspace_creation_when_none_exist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, _token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com"}
        if path == "/ws":
            return []
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    status = await manager.connect("qf-token")

    assert status.connected is False
    assert status.requires_workspace_creation is True
    assert status.requires_workspace_selection is False
    assert status.workspaces == []


@pytest.mark.asyncio
async def test_select_workspace_marks_degraded_sync_when_one_mcp_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, _token_slot = build_manager(
        tmp_path,
        monkeypatch,
        fail_server_id="qingflow-app-builder-mcp",
    )

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com", "lastWsInfo": {"wsId": 101}}
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Alpha"}]
        if path == "/ws/change":
            assert json_body == {"wsId": 101}
            return {"wsId": 101, "workspaceName": "Alpha"}
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    initial = await manager.connect("qf-token")
    assert initial.connected is False

    status = await manager.select_workspace(101)
    await asyncio.sleep(0)
    status = manager.get_status()

    assert status.connected is True
    assert status.mcp_sync.builder_status == McpConnectionStatus.ERROR
    assert status.mcp_sync.user_status == McpConnectionStatus.CONNECTED
    assert "qingflow-app-builder-mcp" in (status.mcp_sync.last_error or "")


@pytest.mark.asyncio
async def test_select_workspace_injects_token_and_workspace_into_default_mcps(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, mcp, _token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com", "lastWsInfo": {"wsId": 101}}
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Alpha"}]
        if path == "/ws/change":
            assert json_body == {"wsId": 101}
            return {"wsId": 101, "workspaceName": "Alpha"}
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    await manager.connect("qf-token")
    await manager.select_workspace(101)
    await asyncio.sleep(0)

    expected_calls = [
        (QINGFLOW_APP_BUILDER_MCP_SERVER_ID, "auth_use_token", {
            "base_url": "https://qingflow.com/api",
            "token": "qf-token",
            "ws_id": "101",
            "persist": True,
        }),
        (QINGFLOW_APP_BUILDER_MCP_SERVER_ID, "workspace_select", {"ws_id": 101}),
        (QINGFLOW_APP_BUILDER_MCP_SERVER_ID, "auth_whoami", {}),
        (QINGFLOW_APP_USER_MCP_SERVER_ID, "auth_use_token", {
            "base_url": "https://qingflow.com/api",
            "token": "qf-token",
            "ws_id": "101",
            "persist": True,
        }),
        (QINGFLOW_APP_USER_MCP_SERVER_ID, "workspace_select", {"ws_id": 101}),
        (QINGFLOW_APP_USER_MCP_SERVER_ID, "auth_whoami", {}),
    ]
    assert mcp.calls == expected_calls


@pytest.mark.asyncio
async def test_logout_clears_cached_settings_and_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager, database, _mcp, token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com", "lastWsInfo": {"wsId": 101}}
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Alpha"}]
        if path == "/ws/change":
            assert json_body == {"wsId": 101}
            return {"wsId": 101, "workspaceName": "Alpha"}
        if path == "/user/quit":
            return {}
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json", fake_request_json)

    await manager.connect("qf-token")
    await manager.select_workspace(101)
    await asyncio.sleep(0)
    status = await manager.logout()

    saved_settings = database.load_settings()
    assert token_slot["value"] is None
    assert status.connected is False
    assert status.token_set is False
    assert saved_settings.qingflow_user_name is None
    assert saved_settings.qingflow_user_email is None
    assert saved_settings.qingflow_user_avatar_url is None
    assert saved_settings.qingflow_selected_ws_id is None
    assert saved_settings.qingflow_selected_ws_name is None


@pytest.mark.asyncio
async def test_select_workspace_returns_before_mcp_sync_finishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, _token_slot = build_manager(tmp_path, monkeypatch)
    release_sync = asyncio.Event()

    async def fake_request_json(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        token: str,
        ws_id: int | None = None,
        json_body: dict[str, object] | None = None,
    ):
        assert token == "qf-token"
        if path == "/user":
            return {"nickName": "Tester", "email": "tester@example.com", "lastWsInfo": {"wsId": 101}}
        if path == "/ws":
            return [{"wsId": 101, "wsName": "Alpha"}]
        if path == "/ws/change":
            assert json_body == {"wsId": 101}
            return {"wsId": 101, "workspaceName": "Alpha"}
        raise AssertionError(f"unexpected path: {path}, ws_id={ws_id}, body={json_body}")

    async def fake_sync_mcp(_api_base_url: str, _token: str, _ws_id: int) -> QingflowMcpSyncState:
        await release_sync.wait()
        return QingflowMcpSyncState(
            builder_status=McpConnectionStatus.CONNECTED,
            user_status=McpConnectionStatus.CONNECTED,
            last_error=None,
        )

    monkeypatch.setattr(manager, "_request_json", fake_request_json)
    monkeypatch.setattr(manager, "_sync_mcp", fake_sync_mcp)

    await manager.connect("qf-token")
    status = await asyncio.wait_for(manager.select_workspace(101), timeout=0.1)

    assert status.connected is True
    assert status.mcp_sync.builder_status == McpConnectionStatus.CONNECTING
    assert status.mcp_sync.user_status == McpConnectionStatus.CONNECTING

    release_sync.set()
    await asyncio.sleep(0)
    settled = manager.get_status()
    assert settled.mcp_sync.builder_status == McpConnectionStatus.CONNECTED
    assert settled.mcp_sync.user_status == McpConnectionStatus.CONNECTED


@pytest.mark.asyncio
async def test_login_with_password_uses_native_login_flow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, database, _mcp, _token_slot = build_manager(tmp_path, monkeypatch)
    settings = database.load_settings()
    settings.qingflow_web_origin = "https://qingflow.com"
    settings.qingflow_api_base_url = "https://qingflow.com/api"
    database.save_settings(settings)
    observed: dict[str, object] = {}

    async def fake_request_json_public(
        base_url: str,
        _method: str,
        path: str,
        *,
        json_body: dict[str, object] | None = None,
    ):
        if path == "/user/pubkey":
            observed["public_key_base_url"] = base_url
            return {"pubkey": "public-key"}
        if path == "/user/pwd":
            observed["pwd_base_url"] = base_url
            observed["pwd_body"] = json_body
            return [{"uid": 42, "ticket": "ticket-1", "wsId": 40013}]
        if path == "/user/login/uid":
            observed["login_base_url"] = base_url
            observed["login_body"] = json_body
            return {"token": "native-login-token", "userSecurityVO": {"multipleFactorInfo": {"authMethod": 0}}}
        raise AssertionError(f"unexpected path: {path}")

    async def fake_connect(token: str, detected_ws_id: int | None = None) -> QingflowAuthStatus:
        observed["connect_token"] = token
        observed["detected_ws_id"] = detected_ws_id
        return QingflowAuthStatus(token_set=True, connected=True)

    monkeypatch.setattr(manager, "_request_json_public", fake_request_json_public)
    monkeypatch.setattr(manager, "_encrypt_password", lambda public_key, password: f"enc::{public_key}::{password}")
    monkeypatch.setattr(manager, "connect", fake_connect)

    status = await manager.login_with_password("tester@example.com", "secret")

    assert status.connected is True
    assert observed["public_key_base_url"] == "https://qingflow.com/api"
    assert observed["pwd_base_url"] == "https://qingflow.com/api"
    assert observed["login_base_url"] == "https://qingflow.com/api"
    assert observed["pwd_body"] == {
        "email": "tester@example.com",
        "password": "enc::public-key::secret",
        "loginType": "email",
    }
    assert observed["login_body"] == {"uid": 42, "ticket": "ticket-1", "loginType": "EMAIL"}
    assert observed["connect_token"] == "native-login-token"
    assert observed["detected_ws_id"] is None


@pytest.mark.asyncio
async def test_login_with_password_rejects_multifactor_accounts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, _token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json_public(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        json_body: dict[str, object] | None = None,
    ):
        if path == "/user/pubkey":
            return {"pubkey": "public-key"}
        if path == "/user/pwd":
            return [{"uid": 42, "ticket": "ticket-1"}]
        if path == "/user/login/uid":
            return {
                "loginToken": "temp-login-token",
                "userSecurityVO": {
                    "beingUninitialized": False,
                    "multipleFactorInfo": {"authMethod": 2},
                },
            }
        raise AssertionError(f"unexpected path: {path}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json_public", fake_request_json_public)
    monkeypatch.setattr(manager, "_encrypt_password", lambda _public_key, _password: "enc-password")

    with pytest.raises(RuntimeError, match="多因子验证"):
        await manager.login_with_password("tester@example.com", "secret")


@pytest.mark.asyncio
async def test_login_with_password_rejects_multiple_candidates_without_preferred_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _database, _mcp, _token_slot = build_manager(tmp_path, monkeypatch)

    async def fake_request_json_public(
        _api_base_url: str,
        _method: str,
        path: str,
        *,
        json_body: dict[str, object] | None = None,
    ):
        if path == "/user/pubkey":
            return {"pubkey": "public-key"}
        if path == "/user/pwd":
            return [
                {"uid": 42, "ticket": "ticket-1", "wsId": 100},
                {"uid": 42, "ticket": "ticket-2", "wsId": 200},
            ]
        raise AssertionError(f"unexpected path: {path}, body={json_body}")

    monkeypatch.setattr(manager, "_request_json_public", fake_request_json_public)
    monkeypatch.setattr(manager, "_encrypt_password", lambda _public_key, _password: "enc-password")

    with pytest.raises(RuntimeError, match="多个可登录身份"):
        await manager.login_with_password("tester@example.com", "secret")

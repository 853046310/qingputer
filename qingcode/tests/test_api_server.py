"""Integration tests for QingCode API server (engine mocked)."""
from __future__ import annotations

import sys
import types

# ── Mock OpenHands before any app imports ──
_openhands_modules = {
    "openhands": None,
    "openhands.core": None,
    "openhands.core.config": None,
    "openhands.core.schema": None,
    "openhands.agenthub": None,
    "openhands.controller": None,
    "openhands.controller.state": None,
    "openhands.controller.state.state": None,
    "openhands.events": None,
    "openhands.events.action": None,
    "openhands.events.event": None,
    "openhands.events.observation": None,
    "openhands.events.stream": None,
    "openhands.llm": None,
    "openhands.llm.llm_registry": None,
    "openhands.storage": None,
    "openhands.storage.memory": None,
    "openhands.runtime": None,
    "openhands.runtime.impl": None,
    "openhands.runtime.impl.local": None,
    "openhands.runtime.impl.local.local_runtime": None,
    "openhands.server": None,
    "openhands.server.services": None,
    "openhands.server.services.conversation_stats": None,
}


class _Stub:
    pass


def _build_mock_modules() -> None:
    root = types.ModuleType("openhands")
    root.core = types.ModuleType("openhands.core")
    root.core.config = types.ModuleType("openhands.core.config")
    root.core.schema = types.ModuleType("openhands.core.schema")
    root.agenthub = types.ModuleType("openhands.agenthub")
    root.controller = types.ModuleType("openhands.controller")
    root.controller.state = types.ModuleType("openhands.controller.state")
    root.controller.state.state = types.ModuleType("openhands.controller.state.state")
    root.events = types.ModuleType("openhands.events")
    root.events.action = types.ModuleType("openhands.events.action")
    root.events.event = types.ModuleType("openhands.events.event")
    root.events.observation = types.ModuleType("openhands.events.observation")
    root.events.stream = types.ModuleType("openhands.events.stream")
    root.llm = types.ModuleType("openhands.llm")
    root.llm.llm_registry = types.ModuleType("openhands.llm.llm_registry")
    root.storage = types.ModuleType("openhands.storage")
    root.storage.memory = types.ModuleType("openhands.storage.memory")
    root.runtime = types.ModuleType("openhands.runtime")
    root.runtime.impl = types.ModuleType("openhands.runtime.impl")
    root.runtime.impl.local = types.ModuleType("openhands.runtime.impl.local")
    root.runtime.impl.local.local_runtime = types.ModuleType(
        "openhands.runtime.impl.local.local_runtime"
    )
    root.server = types.ModuleType("openhands.server")
    root.server.services = types.ModuleType("openhands.server.services")
    root.server.services.conversation_stats = types.ModuleType(
        "openhands.server.services.conversation_stats"
    )

    for attr in ("AppConfig", "OpenHandsConfig", "LLMConfig", "AgentConfig", "SandboxConfig"):
        setattr(root.core.config, attr, _Stub)
    root.core.schema.AgentState = type("AgentState", (), {"FINISHED": "finished"})
    root.agenthub.Agent = _Stub
    root.controller.AgentController = _Stub
    root.controller.state.state.State = _Stub
    root.events.EventStream = _Stub
    root.events.stream.EventStreamSubscriber = type("EventStreamSubscriber", (), {"MAIN": "main"})
    for attr in ("MessageAction", "CmdRunAction", "FileEditAction"):
        setattr(root.events.action, attr, _Stub)
    root.events.event.Event = _Stub
    for attr in (
        "CmdOutputObservation",
        "FileEditObservation",
        "AgentStateChangedObservation",
        "ErrorObservation",
    ):
        setattr(root.events.observation, attr, _Stub)
    root.llm.llm_registry.LLMRegistry = _Stub
    root.storage.memory.InMemoryFileStore = _Stub
    root.runtime.impl.local.local_runtime.LocalRuntime = _Stub
    root.server.services.conversation_stats.ConversationStats = _Stub

    mapping = {
        "openhands": root,
        "openhands.core": root.core,
        "openhands.core.config": root.core.config,
        "openhands.core.schema": root.core.schema,
        "openhands.agenthub": root.agenthub,
        "openhands.controller": root.controller,
        "openhands.controller.state": root.controller.state,
        "openhands.controller.state.state": root.controller.state.state,
        "openhands.events": root.events,
        "openhands.events.action": root.events.action,
        "openhands.events.event": root.events.event,
        "openhands.events.observation": root.events.observation,
        "openhands.events.stream": root.events.stream,
        "openhands.llm": root.llm,
        "openhands.llm.llm_registry": root.llm.llm_registry,
        "openhands.storage": root.storage,
        "openhands.storage.memory": root.storage.memory,
        "openhands.runtime": root.runtime,
        "openhands.runtime.impl": root.runtime.impl,
        "openhands.runtime.impl.local": root.runtime.impl.local,
        "openhands.runtime.impl.local.local_runtime": root.runtime.impl.local.local_runtime,
        "openhands.server": root.server,
        "openhands.server.services": root.server.services,
        "openhands.server.services.conversation_stats": root.server.services.conversation_stats,
    }
    sys.modules.update(mapping)


if "openhands" not in sys.modules:
    _build_mock_modules()

# ── Now safe to import app modules ──

import secrets
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.api.server import create_app
from app.config import QingCodeConfig
from app.storage.qingputer_settings import ModelConfig


def _mock_model_config(**overrides) -> ModelConfig:
    defaults = dict(
        provider="openai",
        base_url="https://api.openai.com/v1",
        model="gpt-4.1",
        api_key="sk-test-key-12345",
        api_key_set=True,
    )
    defaults.update(overrides)
    return ModelConfig(**defaults)


@pytest.fixture()
def token() -> str:
    return secrets.token_urlsafe(16)


@pytest.fixture()
def config(tmp_path: Path) -> QingCodeConfig:
    return QingCodeConfig(data_dir=tmp_path)


@pytest.fixture()
def app(config: QingCodeConfig, token: str):
    with patch("app.api.server.resolve_model_config", return_value=_mock_model_config()):
        yield create_app(config, token)


@pytest_asyncio.fixture()
async def client(app, token: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.headers["Authorization"] = f"Bearer {token}"
        yield c


# ── Health ──


@pytest.mark.asyncio
async def test_health(app, token: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


# ── Auth ──


@pytest.mark.asyncio
async def test_unauthorized(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/api/conversations")
        assert r.status_code == 401


# ── Conversations CRUD ──


@pytest.mark.asyncio
async def test_create_conversation_no_api_key(config: QingCodeConfig, token: str):
    """Without API key configured, create_conversation returns 400."""
    no_key = _mock_model_config(api_key=None, api_key_set=False)
    with patch("app.api.server.resolve_model_config", return_value=no_key):
        app = create_app(config, token)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            c.headers["Authorization"] = f"Bearer {token}"
            r = await c.post("/api/conversations", json={"workspace_path": "/tmp/test"})
            assert r.status_code == 400
            assert "API key" in r.json()["detail"]


@pytest.mark.asyncio
async def test_get_nonexistent_conversation(client: AsyncClient):
    r = await client.get("/api/conversations/nonexistent")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_delete_nonexistent_conversation(client: AsyncClient):
    r = await client.delete("/api/conversations/nonexistent")
    assert r.status_code == 404


# ── Settings ──


@pytest.mark.asyncio
async def test_get_default_settings(client: AsyncClient):
    r = await client.get("/api/settings")
    assert r.status_code == 200
    data = r.json()
    # Read-only fields come from Qingputer (mocked)
    assert data["provider"] == "openai"
    assert data["model"] == "gpt-4.1"
    assert data["api_key_set"] is True
    # Editable defaults
    assert data["max_iterations"] == 50
    assert data["default_workspace"] == ""


@pytest.mark.asyncio
async def test_update_settings(client: AsyncClient):
    r = await client.put(
        "/api/settings",
        json={
            "max_iterations": 30,
            "default_workspace": "/Users/test",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["max_iterations"] == 30
    assert data["default_workspace"] == "/Users/test"
    # Model fields still come from Qingputer mock
    assert data["provider"] == "openai"
    assert data["model"] == "gpt-4.1"


@pytest.mark.asyncio
async def test_update_settings_ignores_extra_fields(client: AsyncClient):
    """PUT /api/settings only accepts max_iterations and default_workspace."""
    r = await client.put(
        "/api/settings",
        json={
            "max_iterations": 25,
            "provider": "custom",
            "model": "should-be-ignored",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["max_iterations"] == 25
    # provider/model remain from Qingputer, not the request
    assert data["provider"] == "openai"
    assert data["model"] == "gpt-4.1"


@pytest.mark.asyncio
async def test_delete_api_key_endpoint_removed(client: AsyncClient):
    """DELETE /api/settings/api-key/{provider} should no longer exist."""
    r = await client.delete("/api/settings/api-key/openai")
    assert r.status_code in (404, 405)


# ── History ──


@pytest.mark.asyncio
async def test_get_history_nonexistent(client: AsyncClient):
    r = await client.get("/api/conversations/nonexistent/history")
    assert r.status_code == 404


# ── Message to nonexistent conversation ──


@pytest.mark.asyncio
async def test_post_message_nonexistent(client: AsyncClient):
    r = await client.post(
        "/api/conversations/nonexistent/messages",
        json={"content": "hello"},
    )
    assert r.status_code == 404

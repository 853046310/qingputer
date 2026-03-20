from fastapi.testclient import TestClient

from app.api.server import create_app


class DummyManager:
    def __init__(self) -> None:
        self.last_settings_payload: dict[str, object] | None = None
        self.last_qingflow_connect: tuple[str, int | None] | None = None
        self.last_qingflow_workspace: int | None = None

    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None

    def get_settings(self) -> dict[str, str]:
        return {"status": "ok"}

    def update_settings(self, **payload: object) -> dict[str, object]:
        self.last_settings_payload = payload
        return payload

    async def get_qingflow_status(self) -> dict[str, object]:
        return {"connected": False}

    async def connect_qingflow(self, token: str, detected_ws_id: int | None) -> dict[str, object]:
        self.last_qingflow_connect = (token, detected_ws_id)
        return {"connected": True, "selected_ws_id": detected_ws_id}

    async def select_qingflow_workspace(self, ws_id: int) -> dict[str, object]:
        self.last_qingflow_workspace = ws_id
        return {"connected": True, "selected_ws_id": ws_id}

    async def logout_qingflow(self) -> dict[str, object]:
        return {"connected": False}

    async def sync_qingflow_mcp(self) -> dict[str, object]:
        return {"connected": True}


def test_cors_allows_null_origin_preflight() -> None:
    app = create_app(DummyManager(), bearer_token="test-token")

    with TestClient(app) as client:
        response = client.options(
            "/api/settings",
            headers={
                "Origin": "null",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] in {"null", "*"}


def test_qingflow_endpoints_are_exposed() -> None:
    manager = DummyManager()
    app = create_app(manager, bearer_token="test-token")

    with TestClient(app) as client:
        headers = {"Authorization": "Bearer test-token"}

        settings_response = client.put(
            "/api/settings",
            headers=headers,
            json={
                "qingflow_web_origin": "https://example.qingflow.com",
                "qingflow_api_base_url": "https://example.qingflow.com/api",
            },
        )
        status_response = client.get("/api/qingflow/status", headers=headers)
        connect_response = client.post(
            "/api/qingflow/connect",
            headers=headers,
            json={"token": "qf-token", "detected_ws_id": 42},
        )
        select_response = client.post(
            "/api/qingflow/select-workspace",
            headers=headers,
            json={"ws_id": 84},
        )
        logout_response = client.post("/api/qingflow/logout", headers=headers)
        sync_response = client.post("/api/qingflow/mcp-sync", headers=headers)

    assert settings_response.status_code == 200
    assert manager.last_settings_payload is not None
    assert manager.last_settings_payload["qingflow_web_origin"] == "https://example.qingflow.com"
    assert manager.last_settings_payload["qingflow_api_base_url"] == "https://example.qingflow.com/api"

    assert status_response.status_code == 200
    assert status_response.json()["connected"] is False

    assert connect_response.status_code == 200
    assert manager.last_qingflow_connect == ("qf-token", 42)

    assert select_response.status_code == 200
    assert manager.last_qingflow_workspace == 84

    assert logout_response.status_code == 200
    assert logout_response.json()["connected"] is False

    assert sync_response.status_code == 200
    assert sync_response.json()["connected"] is True

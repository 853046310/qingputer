from fastapi.testclient import TestClient

from app.api.server import create_app


class DummyManager:
    async def startup(self) -> None:
        return None

    async def shutdown(self) -> None:
        return None

    def get_settings(self) -> dict[str, str]:
        return {"status": "ok"}


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
    assert response.headers["access-control-allow-origin"] == "null"

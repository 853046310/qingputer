from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.models import McpServerConfig, MessageRequest, SessionCreateRequest, SessionUpdateRequest
from app.session import SessionManager


_ALLOWED_ORIGINS = [
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "null",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
]


def create_app(manager: SessionManager, bearer_token: str) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await manager.startup()
        yield
        await manager.shutdown()

    app = FastAPI(title="Qingputer Runtime", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_ALLOWED_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def require_auth(authorization: str | None = Header(default=None)) -> None:
        expected = f"Bearer {bearer_token}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/sessions", dependencies=[Depends(require_auth)])
    async def list_sessions():
        return manager.list_sessions()

    @app.post("/api/sessions", dependencies=[Depends(require_auth)])
    async def create_session(request: SessionCreateRequest):
        return await manager.create_session(request.config, request.title)

    @app.get("/api/sessions/{session_id}", dependencies=[Depends(require_auth)])
    async def get_session(session_id: str):
        try:
            return manager.get_session(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.patch("/api/sessions/{session_id}", dependencies=[Depends(require_auth)])
    async def update_session(session_id: str, request: SessionUpdateRequest):
        try:
            return await manager.update_session(
                session_id,
                title=request.title,
                approval_mode=request.approval_mode,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.delete("/api/sessions/{session_id}", dependencies=[Depends(require_auth)])
    async def delete_session(session_id: str):
        try:
            await manager.delete_session(session_id)
            return {"deleted": True, "session_id": session_id}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/sessions/{session_id}/messages", dependencies=[Depends(require_auth)])
    async def post_message(session_id: str, request: MessageRequest):
        try:
            session = await manager.post_user_message(session_id, request.content)
            return {"session": session, "accepted": True}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/sessions/{session_id}/approvals/{approval_id}/approve", dependencies=[Depends(require_auth)])
    async def approve(session_id: str, approval_id: str):
        try:
            return await manager.resolve_approval(session_id, approval_id, approved=True)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/sessions/{session_id}/approvals/{approval_id}/deny", dependencies=[Depends(require_auth)])
    async def deny(session_id: str, approval_id: str):
        try:
            return await manager.resolve_approval(session_id, approval_id, approved=False)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/sessions/{session_id}/history", dependencies=[Depends(require_auth)])
    async def history(session_id: str):
        try:
            return manager.get_history(session_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/settings", dependencies=[Depends(require_auth)])
    async def get_settings():
        return manager.get_settings()

    @app.put("/api/settings", dependencies=[Depends(require_auth)])
    async def update_settings(payload: dict[str, Any]):
        return manager.update_settings(
            openai_base_url=payload.get("openai_base_url"),
            openai_model=payload.get("openai_model"),
            openai_api_key=payload.get("openai_api_key"),
        )

    @app.delete("/api/settings/openai-key", dependencies=[Depends(require_auth)])
    async def delete_openai_key():
        return manager.delete_openai_api_key()

    @app.post("/api/settings/browser-profile/reset", dependencies=[Depends(require_auth)])
    async def reset_browser_profile():
        manager.reset_browser_profile()
        return {"reset": True}

    @app.get("/api/mcp/servers", dependencies=[Depends(require_auth)])
    async def list_mcp_servers():
        return manager.list_mcp_servers()

    @app.post("/api/mcp/servers", dependencies=[Depends(require_auth)])
    async def create_mcp_server(config: McpServerConfig):
        try:
            return await manager.create_mcp_server(config)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.put("/api/mcp/servers/{server_id}", dependencies=[Depends(require_auth)])
    async def update_mcp_server(server_id: str, config: McpServerConfig):
        try:
            return await manager.update_mcp_server(server_id, config)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.delete("/api/mcp/servers/{server_id}", dependencies=[Depends(require_auth)])
    async def delete_mcp_server(server_id: str):
        try:
            await manager.delete_mcp_server(server_id)
            return {"deleted": True, "server_id": server_id}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/mcp/servers/{server_id}/refresh", dependencies=[Depends(require_auth)])
    async def refresh_mcp_server(server_id: str):
        try:
            return await manager.refresh_mcp_server(server_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.websocket("/api/sessions/{session_id}/events")
    async def events(websocket: WebSocket, session_id: str):
        token = websocket.query_params.get("token")
        if token != bearer_token:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        queue = await manager.subscribe(session_id)
        try:
            while True:
                item = await queue.get()
                await websocket.send_json(item)
        except WebSocketDisconnect:
            await manager.unsubscribe(session_id, queue)

    return app

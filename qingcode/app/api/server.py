from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.agent.engine import QingCodeEngine
from app.config import QingCodeConfig
from app.models.schemas import (
    ChatHistoryResponse,
    ConversationRecord,
    CreateConversationRequest,
    QingCodeSettings,
    SendMessageRequest,
    UpdateSettingsRequest,
    WSEvent,
)
from app.storage.database import Database
from app.storage.qingputer_settings import resolve_model_config

_ALLOWED_ORIGINS = [
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "null",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "*",
]


def create_app(config: QingCodeConfig, bearer_token: str) -> FastAPI:
    db = Database(config.db_path)

    # WebSocket subscriber queues per conversation
    _subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)

    async def broadcast(event: WSEvent) -> None:
        data = event.model_dump(mode="json")
        cid = event.conversation_id
        for q in _subscribers.get(cid, []):
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                pass

    engine = QingCodeEngine(config, db, on_event=broadcast)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await engine.shutdown()

    app = FastAPI(title="QingCode Runtime", version="0.1.0", lifespan=lifespan)
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

    # ── Health ──

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    # ── Conversations ──

    @app.post("/api/conversations", dependencies=[Depends(require_auth)])
    async def create_conversation(request: CreateConversationRequest):
        cid = uuid.uuid4().hex[:16]
        record = db.create_conversation(cid, workspace_path=request.workspace_path)

        # Resolve model settings from Qingputer
        model_config = resolve_model_config()
        if not model_config.api_key:
            raise HTTPException(status_code=400, detail="API key not configured. Please set your API key in Qingputer settings.")

        try:
            await engine.create_conversation(
                conversation_id=cid,
                workspace_path=request.workspace_path,
                model=model_config.model,
                base_url=model_config.base_url,
                api_key=model_config.api_key,
            )
        except Exception as exc:
            db.delete_conversation(cid)
            raise HTTPException(status_code=500, detail=f"Failed to create conversation: {exc}") from exc

        return record

    @app.get("/api/conversations", dependencies=[Depends(require_auth)])
    async def list_conversations():
        return db.list_conversations()

    @app.get("/api/conversations/{conversation_id}", dependencies=[Depends(require_auth)])
    async def get_conversation(conversation_id: str):
        record = db.get_conversation(conversation_id)
        if not record:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return record

    @app.delete("/api/conversations/{conversation_id}", dependencies=[Depends(require_auth)])
    async def delete_conversation(conversation_id: str):
        await engine.stop_conversation(conversation_id)
        deleted = db.delete_conversation(conversation_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return {"deleted": True, "conversation_id": conversation_id}

    # ── Messages ──

    @app.post("/api/conversations/{conversation_id}/messages", dependencies=[Depends(require_auth)])
    async def post_message(conversation_id: str, request: SendMessageRequest):
        record = db.get_conversation(conversation_id)
        if not record:
            raise HTTPException(status_code=404, detail="Conversation not found")
        try:
            await engine.send_message(conversation_id, request.content)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        record = db.get_conversation(conversation_id)
        return {"accepted": True, "conversation": record}

    @app.get("/api/conversations/{conversation_id}/history", dependencies=[Depends(require_auth)])
    async def get_history(conversation_id: str):
        record = db.get_conversation(conversation_id)
        if not record:
            raise HTTPException(status_code=404, detail="Conversation not found")
        messages = db.get_messages(conversation_id)
        return ChatHistoryResponse(conversation=record, messages=messages)

    # ── Settings ──

    def _load_settings() -> QingCodeSettings:
        raw = db.get_settings()
        model_config = resolve_model_config()
        s = QingCodeSettings(
            provider=model_config.provider,
            base_url=model_config.base_url,
            model=model_config.model,
            api_key_set=model_config.api_key_set,
        )
        if "max_iterations" in raw:
            s.max_iterations = int(raw["max_iterations"])
        if "default_workspace" in raw:
            s.default_workspace = raw["default_workspace"]
        return s

    @app.get("/api/settings", dependencies=[Depends(require_auth)])
    async def get_settings():
        return _load_settings()

    @app.put("/api/settings", dependencies=[Depends(require_auth)])
    async def update_settings(request: UpdateSettingsRequest):
        if request.max_iterations is not None:
            db.set_setting("max_iterations", str(request.max_iterations))
        if request.default_workspace is not None:
            db.set_setting("default_workspace", request.default_workspace)
        return _load_settings()

    # ── WebSocket ──

    @app.websocket("/api/conversations/{conversation_id}/events")
    async def events(websocket: WebSocket, conversation_id: str):
        token = websocket.query_params.get("token")
        if token != bearer_token:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
        _subscribers[conversation_id].append(queue)
        try:
            while True:
                item = await queue.get()
                await websocket.send_json(item)
        except WebSocketDisconnect:
            pass
        finally:
            try:
                _subscribers[conversation_id].remove(queue)
            except ValueError:
                pass

    return app

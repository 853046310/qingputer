from __future__ import annotations

import asyncio
import json
import secrets
import socket

import uvicorn

from app.api import create_app
from app.config import AppConfig
from app.session import SessionManager


def _pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as handle:
        handle.bind(("127.0.0.1", 0))
        return int(handle.getsockname()[1])


async def serve() -> None:
    config = AppConfig()
    manager = SessionManager(config)
    token = secrets.token_urlsafe(32)
    port = _pick_port()
    app = create_app(manager, token)
    print(json.dumps({"port": port, "token": token}), flush=True)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="0.0.0.0",
            port=port,
            access_log=False,
            log_level="warning",
        )
    )
    await server.serve()


if __name__ == "__main__":
    asyncio.run(serve())

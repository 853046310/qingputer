import json
import sqlite3

import pytest

from app.config import AppConfig
from app.models import (
    AgentSessionConfig,
    CapabilityGrants,
    SessionRecord,
    SessionStatus,
)
from app.session import SessionManager


def seed_session(config: AppConfig, record: SessionRecord) -> None:
    config.support_directory.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(config.database_path)
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                cwd TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                data_json TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO sessions(id, status, cwd, updated_at, data_json)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                record.session_id,
                record.status.value,
                record.current_cwd,
                record.updated_at.isoformat(),
                json.dumps(record.model_dump(mode="json"), ensure_ascii=True),
            ),
        )
        connection.commit()
    finally:
        connection.close()


@pytest.mark.asyncio
async def test_startup_restores_expired_and_interrupted_sessions_to_authorized(tmp_path) -> None:
    config = AppConfig(home_directory=tmp_path, enable_default_mcp_servers=False)
    expired = SessionRecord(
        title="Expired Session",
        config=AgentSessionConfig(cwd=str(tmp_path), grants=CapabilityGrants()),
        current_cwd=str(tmp_path),
        status=SessionStatus.EXPIRED,
        interrupted_reason="old timeout",
    )
    interrupted = SessionRecord(
        title="Interrupted Session",
        config=AgentSessionConfig(cwd=str(tmp_path), grants=CapabilityGrants()),
        current_cwd=str(tmp_path),
        status=SessionStatus.INTERRUPTED,
        interrupted_reason="old restart",
    )
    seed_session(config, expired)
    seed_session(config, interrupted)

    manager = SessionManager(config)
    await manager.startup()
    try:
        sessions = {session.session_id: session for session in manager.list_sessions()}
        assert sessions[expired.session_id].status == SessionStatus.AUTHORIZED
        assert sessions[interrupted.session_id].status == SessionStatus.AUTHORIZED
        assert sessions[expired.session_id].interrupted_reason is None
        assert sessions[interrupted.session_id].interrupted_reason is None
    finally:
        await manager.shutdown()

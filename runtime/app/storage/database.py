from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import Lock

from app.models import ApprovalRequest, ChatMessage, EventEnvelope, SessionRecord, SettingsPayload


class Database:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = Lock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row

    def initialize(self) -> None:
        with self._lock, self._connection:
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    data_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session_created
                    ON messages(session_id, created_at);
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_session_created
                    ON events(session_id, created_at);
                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT,
                    data_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_approvals_session_created
                    ON approvals(session_id, created_at);
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );
                """
            )

    def save_session(self, session: SessionRecord) -> None:
        payload = json.dumps(session.model_dump(mode="json"), ensure_ascii=True)
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO sessions(id, status, cwd, updated_at, data_json)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status,
                    cwd=excluded.cwd,
                    updated_at=excluded.updated_at,
                    data_json=excluded.data_json
                """,
                (
                    session.session_id,
                    session.status.value,
                    session.current_cwd,
                    session.updated_at.isoformat(),
                    payload,
                ),
            )

    def load_sessions(self) -> list[SessionRecord]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT data_json FROM sessions ORDER BY updated_at DESC"
            ).fetchall()
        return [SessionRecord.model_validate(json.loads(row["data_json"])) for row in rows]

    def delete_session(self, session_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute("DELETE FROM approvals WHERE session_id = ?", (session_id,))
            self._connection.execute("DELETE FROM events WHERE session_id = ?", (session_id,))
            self._connection.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            self._connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT data_json FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        if not row:
            return None
        return SessionRecord.model_validate(json.loads(row["data_json"]))

    def add_message(self, message: ChatMessage) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO messages(id, session_id, role, created_at, content, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    message.message_id,
                    message.session_id,
                    message.role.value,
                    message.created_at.isoformat(),
                    message.content,
                    json.dumps(message.metadata, ensure_ascii=True),
                ),
            )

    def list_messages(self, session_id: str) -> list[ChatMessage]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id, session_id, role, created_at, content, metadata_json
                FROM messages
                WHERE session_id = ?
                ORDER BY created_at ASC
                """,
                (session_id,),
            ).fetchall()
        return [
            ChatMessage(
                message_id=row["id"],
                session_id=row["session_id"],
                role=row["role"],
                content=row["content"],
                created_at=row["created_at"],
                metadata=json.loads(row["metadata_json"]),
            )
            for row in rows
        ]

    def add_event(self, event: EventEnvelope) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO events(id, session_id, kind, created_at, payload_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    event.event_id,
                    event.session_id,
                    event.kind.value,
                    event.created_at.isoformat(),
                    json.dumps(event.payload, ensure_ascii=True),
                ),
            )

    def list_events(self, session_id: str) -> list[EventEnvelope]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT id, session_id, kind, created_at, payload_json
                FROM events
                WHERE session_id = ?
                ORDER BY created_at ASC
                """,
                (session_id,),
            ).fetchall()
        return [
            EventEnvelope(
                event_id=row["id"],
                session_id=row["session_id"],
                kind=row["kind"],
                created_at=row["created_at"],
                payload=json.loads(row["payload_json"]),
            )
            for row in rows
        ]

    def save_approval(self, approval: ApprovalRequest) -> None:
        payload = json.dumps(approval.model_dump(mode="json"), ensure_ascii=True)
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO approvals(id, session_id, status, created_at, resolved_at, data_json)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status,
                    resolved_at=excluded.resolved_at,
                    data_json=excluded.data_json
                """,
                (
                    approval.approval_id,
                    approval.session_id,
                    approval.status.value,
                    approval.created_at.isoformat(),
                    approval.resolved_at.isoformat() if approval.resolved_at else None,
                    payload,
                ),
            )

    def list_approvals(self, session_id: str) -> list[ApprovalRequest]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT data_json
                FROM approvals
                WHERE session_id = ?
                ORDER BY created_at ASC
                """,
                (session_id,),
            ).fetchall()
        return [ApprovalRequest.model_validate(json.loads(row["data_json"])) for row in rows]

    def save_settings(self, settings: SettingsPayload) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO settings(key, value_json)
                VALUES ('settings', ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json
                """,
                (json.dumps(settings.model_dump(mode="json"), ensure_ascii=True),),
            )

    def has_settings(self) -> bool:
        with self._lock:
            row = self._connection.execute(
                "SELECT 1 FROM settings WHERE key = 'settings'"
            ).fetchone()
        return row is not None

    def load_settings_raw(self) -> dict[str, object] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT value_json FROM settings WHERE key = 'settings'"
            ).fetchone()
        if not row:
            return None
        try:
            payload = json.loads(row["value_json"])
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    def load_settings(self) -> SettingsPayload:
        payload = self.load_settings_raw()
        if not payload:
            return SettingsPayload()
        return SettingsPayload.model_validate(payload)

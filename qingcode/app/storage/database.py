from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.models.schemas import (
    ChatMessage,
    ConversationRecord,
    ConversationStatus,
    MessageRole,
    QingCodeSettings,
)


class Database:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._create_tables()

    def _create_tables(self) -> None:
        cur = self._conn.cursor()
        cur.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                conversation_id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New Conversation',
                workspace_path TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)
        self._conn.commit()

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    # ── Conversations ──

    def create_conversation(self, conversation_id: str, workspace_path: str = "", title: str = "New Conversation") -> ConversationRecord:
        now = self._now()
        self._conn.execute(
            "INSERT INTO conversations (conversation_id, title, workspace_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (conversation_id, title, workspace_path, "active", now, now),
        )
        self._conn.commit()
        return ConversationRecord(
            conversation_id=conversation_id,
            title=title,
            workspace_path=workspace_path,
            status=ConversationStatus.active,
            created_at=now,
            updated_at=now,
        )

    def list_conversations(self) -> list[ConversationRecord]:
        rows = self._conn.execute("SELECT * FROM conversations ORDER BY updated_at DESC").fetchall()
        return [ConversationRecord(**dict(r)) for r in rows]

    def get_conversation(self, conversation_id: str) -> ConversationRecord | None:
        row = self._conn.execute("SELECT * FROM conversations WHERE conversation_id = ?", (conversation_id,)).fetchone()
        return ConversationRecord(**dict(row)) if row else None

    def update_conversation(self, conversation_id: str, **kwargs: Any) -> ConversationRecord | None:
        allowed = {"title", "workspace_path", "status"}
        updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
        if not updates:
            return self.get_conversation(conversation_id)
        updates["updated_at"] = self._now()
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        self._conn.execute(
            f"UPDATE conversations SET {set_clause} WHERE conversation_id = ?",  # noqa: S608
            (*updates.values(), conversation_id),
        )
        self._conn.commit()
        return self.get_conversation(conversation_id)

    def delete_conversation(self, conversation_id: str) -> bool:
        self._conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))
        cur = self._conn.execute("DELETE FROM conversations WHERE conversation_id = ?", (conversation_id,))
        self._conn.commit()
        return cur.rowcount > 0

    # ── Messages ──

    def add_message(self, message_id: str, conversation_id: str, role: str, content: str, metadata: dict[str, Any] | None = None) -> ChatMessage:
        now = self._now()
        meta_json = json.dumps(metadata or {})
        self._conn.execute(
            "INSERT INTO messages (message_id, conversation_id, role, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, role, content, now, meta_json),
        )
        self._conn.commit()
        # touch conversation
        self._conn.execute("UPDATE conversations SET updated_at = ? WHERE conversation_id = ?", (now, conversation_id))
        self._conn.commit()
        return ChatMessage(
            message_id=message_id,
            conversation_id=conversation_id,
            role=MessageRole(role),
            content=content,
            created_at=now,
            metadata=metadata or {},
        )

    def get_messages(self, conversation_id: str) -> list[ChatMessage]:
        rows = self._conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        ).fetchall()
        result: list[ChatMessage] = []
        for r in rows:
            d = dict(r)
            d["metadata"] = json.loads(d["metadata"]) if isinstance(d["metadata"], str) else d["metadata"]
            result.append(ChatMessage(**d))
        return result

    def update_message_content(self, message_id: str, content: str) -> None:
        self._conn.execute("UPDATE messages SET content = ? WHERE message_id = ?", (content, message_id))
        self._conn.commit()

    # ── Settings ──

    def get_settings(self) -> dict[str, str]:
        rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}

    def set_setting(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self._conn.commit()

    def delete_setting(self, key: str) -> None:
        self._conn.execute("DELETE FROM settings WHERE key = ?", (key,))
        self._conn.commit()

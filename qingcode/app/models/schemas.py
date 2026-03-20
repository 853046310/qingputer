from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ConversationStatus(str, Enum):
    active = "active"
    paused = "paused"
    completed = "completed"
    error = "error"


class ConversationRecord(BaseModel):
    conversation_id: str
    title: str = "New Conversation"
    workspace_path: str = ""
    status: ConversationStatus = ConversationStatus.active
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class MessageRole(str, Enum):
    user = "user"
    assistant = "assistant"
    tool = "tool"
    system = "system"


class ChatMessage(BaseModel):
    message_id: str
    conversation_id: str
    role: MessageRole
    content: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: dict[str, Any] = Field(default_factory=dict)


class ChatHistoryResponse(BaseModel):
    conversation: ConversationRecord
    messages: list[ChatMessage]


class CreateConversationRequest(BaseModel):
    workspace_path: str = ""


class SendMessageRequest(BaseModel):
    content: str


class QingCodeSettings(BaseModel):
    # Read-only fields from Qingputer config
    provider: str = ""
    base_url: str = ""
    model: str = ""
    api_key_set: bool = False
    # Editable QingCode-specific fields
    max_iterations: int = 50
    default_workspace: str = ""


class UpdateSettingsRequest(BaseModel):
    max_iterations: int | None = None
    default_workspace: str | None = None


class WSEventType(str, Enum):
    agent_message = "agent_message"
    agent_message_chunk = "agent_message_chunk"
    agent_message_end = "agent_message_end"
    action = "action"
    observation = "observation"
    terminal_output = "terminal_output"
    file_change = "file_change"
    error = "error"
    status = "status"


class WSEvent(BaseModel):
    event_id: str
    conversation_id: str
    type: WSEventType
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

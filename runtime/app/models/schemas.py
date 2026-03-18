from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class SessionStatus(str, Enum):
    CREATED = "created"
    AUTHORIZED = "authorized"
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    TERMINATED = "terminated"
    EXPIRED = "expired"
    INTERRUPTED = "interrupted"


class MessageRole(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    SYSTEM = "system"


class EventKind(str, Enum):
    MESSAGE = "message"
    COMMAND_STARTED = "command_started"
    COMMAND_OUTPUT = "command_output"
    COMMAND_FINISHED = "command_finished"
    FILE_READ = "file_read"
    FILE_WRITE = "file_write"
    FILE_LIST = "file_list"
    BROWSER_NAV = "browser_nav"
    BROWSER_ACTION = "browser_action"
    MCP_CALL = "mcp_call"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_RESOLVED = "approval_resolved"
    POLICY = "policy"
    ERROR = "error"
    STATUS = "status"
    ASSISTANT_STREAM_START = "assistant_stream_start"
    ASSISTANT_CHUNK = "assistant_chunk"
    ASSISTANT_STREAM_END = "assistant_stream_end"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class PolicyVerdict(str, Enum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"


class ApprovalMode(str, Enum):
    DEFAULT = "default"
    MAXIMUM = "maximum"
    LEGACY_RISK_BASED = "session_once_plus_high_risk"

    @classmethod
    def normalize(cls, value: str | None) -> "ApprovalMode":
        if value == cls.MAXIMUM.value:
            return cls.MAXIMUM
        if value == cls.LEGACY_RISK_BASED.value:
            return cls.LEGACY_RISK_BASED
        return cls.DEFAULT


class AgentActionKind(str, Enum):
    TERMINAL_RUN = "terminal.run"
    TERMINAL_KILL = "terminal.kill"
    FILESYSTEM_READ = "fs.read"
    FILESYSTEM_WRITE = "fs.write"
    FILESYSTEM_LIST = "fs.list"
    BROWSER_OPEN = "browser.open"
    BROWSER_CLICK = "browser.click"
    BROWSER_TYPE = "browser.type"
    BROWSER_EXTRACT = "browser.extract"
    MCP_CALL = "mcp.call"
    FINAL_ANSWER = "final_answer"


class McpTransport(str, Enum):
    STDIO = "stdio"
    STREAMABLE_HTTP = "streamable_http"


class McpConnectionStatus(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


class CapabilityGrants(BaseModel):
    terminal: bool = True
    filesystem: bool = True
    browser: bool = True


class AgentSessionConfig(BaseModel):
    cwd: str
    grants: CapabilityGrants = Field(default_factory=CapabilityGrants)
    approval_mode: ApprovalMode = ApprovalMode.DEFAULT
    idle_timeout_minutes: int = 60
    absolute_timeout_hours: int = 8


class SessionRecord(BaseModel):
    session_id: str = Field(default_factory=lambda: uuid4().hex)
    title: str = "Untitled Session"
    config: AgentSessionConfig
    status: SessionStatus = SessionStatus.CREATED
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    last_active_at: datetime = Field(default_factory=utc_now)
    current_cwd: str
    pending_approval_id: str | None = None
    interrupted_reason: str | None = None


class AgentAction(BaseModel):
    kind: AgentActionKind
    summary: str | None = None
    args: dict[str, Any] = Field(default_factory=dict)


class PolicyDecision(BaseModel):
    verdict: PolicyVerdict
    risk_level: RiskLevel
    reason: str


class ChatMessage(BaseModel):
    message_id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    role: MessageRole
    content: str
    created_at: datetime = Field(default_factory=utc_now)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EventEnvelope(BaseModel):
    event_id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    kind: EventKind
    payload: dict[str, Any]
    created_at: datetime = Field(default_factory=utc_now)


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


class ApprovalRequest(BaseModel):
    approval_id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    action: AgentAction
    reason: str
    risk_level: RiskLevel
    preview: str
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: datetime = Field(default_factory=utc_now)
    resolved_at: datetime | None = None
    resolution_note: str | None = None


class SessionCreateRequest(BaseModel):
    config: AgentSessionConfig
    title: str | None = Field(default=None, min_length=1)


class SessionUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    approval_mode: ApprovalMode | None = None


class MessageRequest(BaseModel):
    content: str = Field(min_length=1)


class BrowserActionHints(BaseModel):
    selector: str | None = None
    text: str | None = None
    url: str | None = None


class ChatHistoryResponse(BaseModel):
    session: SessionRecord
    messages: list[ChatMessage]
    approvals: list[ApprovalRequest]
    events: list[EventEnvelope]


class McpServerConfig(BaseModel):
    server_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    transport: McpTransport = McpTransport.STDIO
    enabled: bool = True
    auto_connect: bool = True
    description: str | None = None
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    cwd: str | None = None
    url: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)


class McpToolDescriptor(BaseModel):
    server_id: str
    name: str
    title: str | None = None
    description: str | None = None
    input_schema: dict[str, Any] | None = None


class McpServerRuntimeState(BaseModel):
    config: McpServerConfig
    status: McpConnectionStatus = McpConnectionStatus.DISCONNECTED
    last_error: str | None = None
    tools: list[McpToolDescriptor] = Field(default_factory=list)
    server_name: str | None = None
    server_version: str | None = None
    instructions: str | None = None


class SettingsPayload(BaseModel):
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4.1"
    openai_api_key_set: bool = False
    mcp_defaults_initialized: bool = False
    mcp_servers: list[McpServerConfig] = Field(default_factory=list)


QINGFLOW_MCP_DEFAULT_BASE_URL = "https://qingflow.com/api"
QINGFLOW_LEGACY_MCP_SERVER_ID = "qingflow-mcp"
QINGFLOW_APP_USER_MCP_SERVER_ID = "qingflow-app-user-mcp"
QINGFLOW_APP_BUILDER_MCP_SERVER_ID = "qingflow-app-builder-mcp"
QINGFLOW_APP_USER_MCP_PACKAGE = "@josephyan/qingflow-app-user-mcp"
QINGFLOW_APP_USER_MCP_VERSION = "0.1.0-beta.9"
QINGFLOW_APP_BUILDER_MCP_PACKAGE = "@josephyan/qingflow-app-builder-mcp"
QINGFLOW_APP_BUILDER_MCP_VERSION = "0.1.0-beta.12"


def default_qingflow_mcp_command() -> str:
    return "npx"


def default_qingflow_mcp_args(server_id: str) -> list[str]:
    if server_id == QINGFLOW_APP_USER_MCP_SERVER_ID:
        return ["-y", f"{QINGFLOW_APP_USER_MCP_PACKAGE}@{QINGFLOW_APP_USER_MCP_VERSION}"]
    if server_id == QINGFLOW_APP_BUILDER_MCP_SERVER_ID:
        return ["-y", f"{QINGFLOW_APP_BUILDER_MCP_PACKAGE}@{QINGFLOW_APP_BUILDER_MCP_VERSION}"]
    raise ValueError(f"Unsupported Qingflow MCP server id: {server_id}")


def default_qingflow_app_user_mcp_server() -> McpServerConfig:
    return McpServerConfig(
        server_id=QINGFLOW_APP_USER_MCP_SERVER_ID,
        name="Qingflow App User MCP",
        transport=McpTransport.STDIO,
        enabled=True,
        auto_connect=True,
        description="Default Qingflow App User stdio MCP server shared by all sessions.",
        command=default_qingflow_mcp_command(),
        args=default_qingflow_mcp_args(QINGFLOW_APP_USER_MCP_SERVER_ID),
        env={"QINGFLOW_MCP_DEFAULT_BASE_URL": QINGFLOW_MCP_DEFAULT_BASE_URL},
    )


def default_qingflow_app_builder_mcp_server() -> McpServerConfig:
    return McpServerConfig(
        server_id=QINGFLOW_APP_BUILDER_MCP_SERVER_ID,
        name="Qingflow App Builder MCP",
        transport=McpTransport.STDIO,
        enabled=True,
        auto_connect=True,
        description="Default Qingflow App Builder stdio MCP server shared by all sessions.",
        command=default_qingflow_mcp_command(),
        args=default_qingflow_mcp_args(QINGFLOW_APP_BUILDER_MCP_SERVER_ID),
        env={"QINGFLOW_MCP_DEFAULT_BASE_URL": QINGFLOW_MCP_DEFAULT_BASE_URL},
    )


def default_mcp_servers() -> list[McpServerConfig]:
    return [default_qingflow_app_user_mcp_server(), default_qingflow_app_builder_mcp_server()]

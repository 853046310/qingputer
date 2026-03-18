from __future__ import annotations

import asyncio
import json
import os
import shutil
import textwrap
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from app.agent import AgentLoop, OpenAIProvider
from app.capabilities import BrowserCapability, CapabilityRouter, FilesystemCapability, McpCapability, TerminalCapability
from app.capabilities.browser import BrowserSession
from app.capabilities.terminal import TerminalSession
from app.config import AppConfig
from app.mcp import McpManager
from app.models import (
    ApprovalMode,
    AgentAction,
    AgentSessionConfig,
    ApprovalRequest,
    ApprovalStatus,
    ChatHistoryResponse,
    ChatMessage,
    EventEnvelope,
    EventKind,
    MessageRole,
    default_mcp_servers,
    default_qingflow_app_builder_mcp_server,
    default_qingflow_app_user_mcp_server,
    PolicyDecision,
    SessionRecord,
    SessionStatus,
    SettingsPayload,
    McpServerConfig,
    McpServerRuntimeState,
)
from app.policy import PolicyEngine
from app.storage import AuditLogger, Database, SecretStore
from app.storage.paths import ensure_directories


@dataclass
class LiveSession:
    record: SessionRecord
    terminal_session: TerminalSession
    browser_session: BrowserSession = field(default_factory=BrowserSession)
    subscribers: set[asyncio.Queue[dict[str, object]]] = field(default_factory=set)
    agent_task: asyncio.Task[None] | None = None


class SessionManager:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        ensure_directories(config)
        self.database = Database(config.database_path)
        self.audit = AuditLogger(config)
        self.secret_store = SecretStore(config)
        self.provider = OpenAIProvider(config, self.database, self.secret_store)
        self.policy = PolicyEngine(config)
        self._terminal = TerminalCapability(config)
        self._filesystem = FilesystemCapability(config)
        self._browser = BrowserCapability(config)
        self._mcp = McpManager()
        self._router = CapabilityRouter(self._terminal, self._filesystem, self._browser, McpCapability(self._mcp))
        self._loop = AgentLoop()
        self._live_sessions: dict[str, LiveSession] = {}
        self._pending_approvals: dict[str, ApprovalRequest] = {}
        self._runtime_loop: asyncio.AbstractEventLoop | None = None

    async def startup(self) -> None:
        self._runtime_loop = asyncio.get_running_loop()
        self.database.initialize()
        for record in self.database.load_sessions():
            normalized = self._normalize_persisted_record(record)
            if normalized:
                self.database.save_session(record)
            self._live_sessions[record.session_id] = self._make_live_session(record)
        settings = self.database.load_settings()
        settings_changed = False
        if self.config.enable_default_mcp_servers and not settings.mcp_defaults_initialized:
            if not settings.mcp_servers:
                settings.mcp_servers = default_mcp_servers()
                settings_changed = True
            settings.mcp_defaults_initialized = True
            settings_changed = True
        migrated_servers, migrated = self._migrate_managed_mcp_servers(settings.mcp_servers)
        if migrated:
            settings.mcp_servers = migrated_servers
            settings_changed = True
        if settings_changed:
            self.database.save_settings(settings)
        await self._mcp.startup(settings.mcp_servers)

    async def shutdown(self) -> None:
        for live_session in self._live_sessions.values():
            if live_session.agent_task and not live_session.agent_task.done():
                live_session.agent_task.cancel()
            await self._terminal.close(live_session.terminal_session)
            await self._browser.close(live_session.browser_session)
        await self._browser.shutdown()
        await self._mcp.shutdown()

    def _make_live_session(self, record: SessionRecord) -> LiveSession:
        terminal_session = TerminalSession(
            shell=self.config.login_shell,
            cwd=record.current_cwd,
            env=os.environ.copy(),
        )
        return LiveSession(record=record, terminal_session=terminal_session)

    def require_session(self, session_id: str) -> LiveSession:
        live_session = self._live_sessions.get(session_id)
        if not live_session:
            raise KeyError(f"Unknown session: {session_id}")
        return live_session

    async def create_session(self, config: AgentSessionConfig, title: str | None = None) -> SessionRecord:
        cwd = str(Path(config.cwd).expanduser().resolve())
        session_record = SessionRecord(
            title=(title or self._default_session_title()).strip(),
            config=config,
            status=SessionStatus.AUTHORIZED,
            current_cwd=cwd,
            interrupted_reason=None,
        )
        live_session = self._make_live_session(session_record)
        self._live_sessions[session_record.session_id] = live_session
        self.database.save_session(session_record)
        await self.publish_event(session_record.session_id, EventKind.STATUS, {"status": session_record.status.value})
        return session_record

    def list_sessions(self) -> list[SessionRecord]:
        return sorted(
            (live_session.record for live_session in self._live_sessions.values()),
            key=lambda record: record.updated_at,
            reverse=True,
        )

    async def update_session(
        self,
        session_id: str,
        *,
        title: str | None = None,
        approval_mode: ApprovalMode | None = None,
    ) -> SessionRecord:
        live_session = self.require_session(session_id)
        if title is not None:
            trimmed = title.strip()
            if not trimmed:
                raise ValueError("Session title cannot be empty.")
            live_session.record.title = trimmed
        if approval_mode is not None:
            live_session.record.config.approval_mode = approval_mode
        live_session.record.updated_at = datetime.now(timezone.utc)
        self.database.save_session(live_session.record)
        return live_session.record

    async def delete_session(self, session_id: str) -> None:
        live_session = self.require_session(session_id)
        if live_session.agent_task and not live_session.agent_task.done():
            live_session.agent_task.cancel()
        await self._terminal.close(live_session.terminal_session)
        await self._browser.close(live_session.browser_session)
        for approval in self.database.list_approvals(session_id):
            self._pending_approvals.pop(approval.approval_id, None)
        self._live_sessions.pop(session_id, None)
        self.database.delete_session(session_id)
        audit_path = self.audit.export_path(session_id)
        if audit_path.exists():
            audit_path.unlink()

    async def set_status(self, session_id: str, status: SessionStatus) -> None:
        live_session = self.require_session(session_id)
        now = datetime.now(timezone.utc)
        live_session.record.status = status
        live_session.record.updated_at = now
        self.database.save_session(live_session.record)
        await self.publish_event(session_id, EventKind.STATUS, {"status": status.value})

    async def touch(self, session_id: str) -> None:
        live_session = self.require_session(session_id)
        now = datetime.now(timezone.utc)
        live_session.record.last_active_at = now
        live_session.record.updated_at = now
        self.database.save_session(live_session.record)

    async def add_message(
        self,
        session_id: str,
        role: MessageRole,
        content: str,
        metadata: dict[str, object] | None = None,
        message_id: str | None = None,
    ) -> ChatMessage:
        await self.touch(session_id)
        kwargs: dict[str, object] = {}
        if message_id:
            kwargs["message_id"] = message_id
        message = ChatMessage(session_id=session_id, role=role, content=content, metadata=metadata or {}, **kwargs)
        self.database.add_message(message)
        await self.publish_event(
            session_id,
            EventKind.MESSAGE,
            {"message_id": message.message_id, "role": role.value, "content": content, "metadata": message.metadata},
        )
        return message

    async def publish_ephemeral_event(self, session_id: str, kind: EventKind, payload: dict[str, object]) -> None:
        """Publish event to WebSocket subscribers only — not stored to database or audit log."""
        envelope = EventEnvelope(session_id=session_id, kind=kind, payload=payload)
        live_session = self._live_sessions.get(session_id)
        if live_session:
            data = envelope.model_dump(mode="json")
            for queue in list(live_session.subscribers):
                await queue.put(data)

    async def stream_assistant_reply(
        self,
        session_id: str,
        *,
        message_id: str,
        content: str,
        chunk_delay_ms: int = 14,
    ) -> None:
        await self.publish_ephemeral_event(
            session_id,
            EventKind.ASSISTANT_STREAM_START,
            {"message_id": message_id},
        )
        for chunk in self._chunk_assistant_text(content):
            await self.publish_ephemeral_event(
                session_id,
                EventKind.ASSISTANT_CHUNK,
                {"message_id": message_id, "chunk": chunk},
            )
            if chunk_delay_ms > 0:
                await asyncio.sleep(chunk_delay_ms / 1000)
        await self.publish_ephemeral_event(
            session_id,
            EventKind.ASSISTANT_STREAM_END,
            {"message_id": message_id},
        )

    async def post_user_message(self, session_id: str, content: str) -> SessionRecord:
        live_session = self.require_session(session_id)
        if live_session.record.status == SessionStatus.PAUSED:
            raise RuntimeError("This session is waiting for a human approval before it can continue.")
        if live_session.agent_task and not live_session.agent_task.done():
            raise RuntimeError("The agent is already processing a turn for this session.")
        configuration_error = self.provider.configuration_error()
        if configuration_error:
            raise RuntimeError(configuration_error)
        await self.add_message(session_id, MessageRole.USER, content)
        live_session.agent_task = asyncio.create_task(self._loop.run(self, session_id))
        return live_session.record

    async def create_approval(self, session_id: str, action: AgentAction, decision: PolicyDecision) -> ApprovalRequest:
        live_session = self.require_session(session_id)
        preview = self._action_preview(action)
        approval = ApprovalRequest(
            session_id=session_id,
            action=action,
            reason=decision.reason,
            risk_level=decision.risk_level,
            preview=preview,
        )
        live_session.record.pending_approval_id = approval.approval_id
        live_session.record.updated_at = datetime.now(timezone.utc)
        self._pending_approvals[approval.approval_id] = approval
        self.database.save_session(live_session.record)
        self.database.save_approval(approval)
        await self.publish_event(
            session_id,
            EventKind.APPROVAL_REQUESTED,
            approval.model_dump(mode="json"),
        )
        return approval

    async def resolve_approval(self, session_id: str, approval_id: str, approved: bool) -> ApprovalRequest:
        live_session = self.require_session(session_id)
        approval = self._pending_approvals.get(approval_id)
        if approval is None:
            for item in self.database.list_approvals(session_id):
                if item.approval_id == approval_id:
                    approval = item
                    break
        if approval is None:
            raise KeyError(f"Unknown approval: {approval_id}")
        approval.status = ApprovalStatus.APPROVED if approved else ApprovalStatus.DENIED
        approval.resolved_at = datetime.now(timezone.utc)
        approval.resolution_note = "Approved by user." if approved else "Denied by user."
        live_session.record.pending_approval_id = None
        live_session.record.updated_at = approval.resolved_at
        self._pending_approvals.pop(approval_id, None)
        self.database.save_approval(approval)
        self.database.save_session(live_session.record)
        await self.publish_event(session_id, EventKind.APPROVAL_RESOLVED, approval.model_dump(mode="json"))
        if approved:
            await self.execute_action(session_id, approval.action)
        else:
            await self.add_message(
                session_id,
                MessageRole.TOOL,
                json.dumps({"approval_denied": approval.action.model_dump(mode="json"), "reason": approval.reason}, ensure_ascii=True),
                {
                    "approval_denied": True,
                    "action_kind": approval.action.kind.value,
                    "action_summary": approval.action.summary,
                    "server_id": approval.action.args.get("server_id"),
                    "tool_name": approval.action.args.get("tool_name"),
                },
            )
        await self.set_status(session_id, SessionStatus.ACTIVE)
        live_session.agent_task = asyncio.create_task(self._loop.run(self, session_id))
        return approval

    async def execute_action(self, session_id: str, action: AgentAction) -> dict[str, object]:
        live_session = self.require_session(session_id)
        await self.touch(session_id)
        if action.kind.value.startswith("terminal.run"):
            await self.publish_event(session_id, EventKind.COMMAND_STARTED, {"command": action.args.get("command", "")})

        async def on_terminal_output(chunk: str) -> None:
            await self.publish_event(session_id, EventKind.COMMAND_OUTPUT, {"chunk": chunk})

        result, event_kind = await self._router.execute(
            action,
            terminal_session=live_session.terminal_session,
            browser_session=live_session.browser_session,
            on_terminal_output=on_terminal_output,
        )
        live_session.record.current_cwd = live_session.terminal_session.cwd
        live_session.record.updated_at = datetime.now(timezone.utc)
        self.database.save_session(live_session.record)
        await self.publish_event(
            session_id,
            event_kind,
            {
                "action": action.model_dump(mode="json"),
                "result": result,
            },
        )
        await self.add_message(
            session_id,
            MessageRole.TOOL,
            json.dumps(result, ensure_ascii=True)[: self.config.file_excerpt_bytes],
            {
                "action_kind": action.kind.value,
                "action_summary": action.summary,
                "server_id": action.args.get("server_id"),
                "tool_name": action.args.get("tool_name"),
            },
        )
        return result

    async def publish_policy_decision(self, session_id: str, action: AgentAction, decision: PolicyDecision) -> None:
        await self.publish_event(
            session_id,
            EventKind.POLICY,
            {
                "action": action.model_dump(mode="json"),
                "decision": decision.model_dump(mode="json"),
            },
        )

    async def publish_error(self, session_id: str, message: str) -> None:
        await self.publish_event(session_id, EventKind.ERROR, {"message": message})

    async def publish_event(self, session_id: str, kind: EventKind, payload: dict[str, object]) -> EventEnvelope:
        envelope = EventEnvelope(session_id=session_id, kind=kind, payload=payload)
        self.database.add_event(envelope)
        self.audit.append(envelope)
        live_session = self._live_sessions.get(session_id)
        if live_session:
            for queue in list(live_session.subscribers):
                await queue.put(envelope.model_dump(mode="json"))
        return envelope

    async def subscribe(self, session_id: str) -> asyncio.Queue[dict[str, object]]:
        live_session = self.require_session(session_id)
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        live_session.subscribers.add(queue)
        return queue

    async def unsubscribe(self, session_id: str, queue: asyncio.Queue[dict[str, object]]) -> None:
        live_session = self._live_sessions.get(session_id)
        if live_session:
            live_session.subscribers.discard(queue)

    def build_provider_context(
        self,
        session_id: str,
        *,
        loop_state: dict[str, object] | None = None,
    ) -> dict[str, object]:
        live_session = self.require_session(session_id)
        messages = self.database.list_messages(session_id)
        events = self.database.list_events(session_id)[-self.config.event_context_limit :]
        context = {
            "session": live_session.record.model_dump(mode="json"),
            "messages": [message.model_dump(mode="json") for message in messages],
            "recent_events": [event.model_dump(mode="json") for event in events],
            "mcp": self._mcp.tool_context(),
            "limits": {
                "event_context_limit": self.config.event_context_limit,
                "command_tail_lines": self.config.command_tail_lines,
                "file_excerpt_bytes": self.config.file_excerpt_bytes,
                "page_excerpt_bytes": self.config.page_excerpt_bytes,
            },
        }
        if loop_state:
            context["loop_state"] = loop_state
        return context

    def get_session(self, session_id: str) -> SessionRecord:
        return self.require_session(session_id).record

    def get_history(self, session_id: str) -> ChatHistoryResponse:
        self.require_session(session_id)
        return ChatHistoryResponse(
            session=self.database.get_session(session_id) or self.get_session(session_id),
            messages=self.database.list_messages(session_id),
            approvals=self.database.list_approvals(session_id),
            events=self.database.list_events(session_id),
        )

    def get_settings(self) -> SettingsPayload:
        settings = self.database.load_settings()
        settings.openai_api_key_set = self.secret_store.has_openai_api_key()
        return settings

    def update_settings(
        self,
        *,
        openai_base_url: str | None = None,
        openai_model: str | None = None,
        openai_api_key: str | None = None,
    ) -> SettingsPayload:
        settings = self.database.load_settings()
        if openai_base_url:
            settings.openai_base_url = openai_base_url.rstrip("/")
        if openai_model:
            settings.openai_model = openai_model
        if openai_api_key is not None:
            self.secret_store.set_openai_api_key(openai_api_key)
            settings.openai_api_key_set = True
        self.database.save_settings(settings)
        return settings

    def delete_openai_api_key(self) -> SettingsPayload:
        settings = self.database.load_settings()
        self.secret_store.delete_openai_api_key()
        settings.openai_api_key_set = False
        self.database.save_settings(settings)
        return settings

    def reset_browser_profile(self) -> None:
        target = Path(self.config.browser_profile_directory)
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)

    def list_mcp_servers(self) -> list[McpServerRuntimeState]:
        return self._mcp.list_states()

    async def create_mcp_server(self, config: McpServerConfig) -> McpServerRuntimeState:
        settings = self.database.load_settings()
        if any(server.server_id == config.server_id for server in settings.mcp_servers):
            raise ValueError(f"MCP server id already exists: {config.server_id}")
        settings.mcp_servers.append(config)
        self.database.save_settings(settings)
        await self._mcp.sync_servers(settings.mcp_servers)
        return self._require_mcp_state(config.server_id)

    async def update_mcp_server(self, server_id: str, config: McpServerConfig) -> McpServerRuntimeState:
        if server_id != config.server_id:
            raise ValueError("MCP server id in the path must match the payload.")
        settings = self.database.load_settings()
        updated = False
        next_servers: list[McpServerConfig] = []
        for server in settings.mcp_servers:
            if server.server_id == server_id:
                next_servers.append(config)
                updated = True
            else:
                next_servers.append(server)
        if not updated:
            raise KeyError(f"Unknown MCP server: {server_id}")
        settings.mcp_servers = next_servers
        self.database.save_settings(settings)
        await self._mcp.sync_servers(settings.mcp_servers)
        return self._require_mcp_state(server_id)

    async def delete_mcp_server(self, server_id: str) -> None:
        settings = self.database.load_settings()
        next_servers = [server for server in settings.mcp_servers if server.server_id != server_id]
        if len(next_servers) == len(settings.mcp_servers):
            raise KeyError(f"Unknown MCP server: {server_id}")
        settings.mcp_servers = next_servers
        self.database.save_settings(settings)
        await self._mcp.sync_servers(settings.mcp_servers)

    async def refresh_mcp_server(self, server_id: str) -> McpServerRuntimeState:
        if not self._mcp.has_server(server_id):
            settings = self.database.load_settings()
            await self._mcp.sync_servers(settings.mcp_servers)
        return await self._mcp.refresh_server(server_id)

    @staticmethod
    def _migrate_managed_mcp_servers(servers: list[McpServerConfig]) -> tuple[list[McpServerConfig], bool]:
        legacy_id = "qingflow-mcp"
        managed_defaults = {
            default.server_id: default
            for default in (default_qingflow_app_user_mcp_server(), default_qingflow_app_builder_mcp_server())
        }
        managed_ids = set(managed_defaults) | {legacy_id}
        existing_by_id = {server.server_id: server for server in servers if server.server_id in managed_ids}
        if not existing_by_id:
            return servers, False

        legacy_server = existing_by_id.get(legacy_id)
        next_servers = [server for server in servers if server.server_id not in managed_ids]
        for server_id, default_server in managed_defaults.items():
            existing = existing_by_id.get(server_id)
            env = dict(default_server.env)
            if legacy_server is not None:
                env.update(legacy_server.env)
            if existing is not None:
                env.update(existing.env)
            seed = existing or legacy_server or default_server
            next_servers.append(
                default_server.model_copy(
                    update={
                        "enabled": seed.enabled,
                        "auto_connect": seed.auto_connect,
                        "env": env,
                    }
                )
            )
        return next_servers, True

    @staticmethod
    def _action_preview(action: AgentAction) -> str:
        if "command" in action.args:
            return str(action.args["command"])[:200]
        if "path" in action.args:
            return str(action.args["path"])[:200]
        if "url" in action.args:
            return str(action.args["url"])[:200]
        if "tool_name" in action.args:
            server_id = str(action.args.get("server_id", ""))
            tool_name = str(action.args["tool_name"])
            return f"{server_id}:{tool_name}"[:200]
        return json.dumps(action.args, ensure_ascii=True)[:200]

    @staticmethod
    def _chunk_assistant_text(content: str, target_size: int = 28) -> list[str]:
        if not content:
            return []
        chunks: list[str] = []
        for paragraph in content.splitlines(keepends=True):
            if len(paragraph) <= target_size:
                chunks.append(paragraph)
                continue
            wrapped = textwrap.wrap(
                paragraph,
                width=target_size,
                break_long_words=False,
                break_on_hyphens=False,
                drop_whitespace=False,
                replace_whitespace=False,
            )
            if wrapped:
                chunks.extend(wrapped)
            else:
                chunks.append(paragraph)
        return [chunk for chunk in chunks if chunk]

    @staticmethod
    def _default_session_title() -> str:
        local_now = datetime.now().astimezone()
        return local_now.strftime("Session %m-%d %H:%M")

    @staticmethod
    def _normalize_persisted_record(record: SessionRecord) -> bool:
        normalized = False
        if record.status in {
            SessionStatus.CREATED,
            SessionStatus.ACTIVE,
            SessionStatus.EXPIRED,
            SessionStatus.INTERRUPTED,
        }:
            record.status = SessionStatus.AUTHORIZED
            normalized = True
        if record.interrupted_reason is not None:
            record.interrupted_reason = None
            normalized = True
        if normalized:
            record.updated_at = datetime.now(timezone.utc)
        return normalized

    def _require_mcp_state(self, server_id: str) -> McpServerRuntimeState:
        for state in self._mcp.list_states():
            if state.config.server_id == server_id:
                return state
        raise KeyError(f"Unknown MCP server: {server_id}")

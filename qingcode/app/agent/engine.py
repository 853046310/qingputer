from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any, Callable, Coroutine

from pydantic import SecretStr

from openhands.core.config import OpenHandsConfig, LLMConfig, AgentConfig, SandboxConfig
from openhands.core.schema import AgentState
from openhands.agenthub import Agent
from openhands.controller import AgentController
from openhands.controller.state.state import State
from openhands.events import EventStream
from openhands.events.stream import EventStreamSubscriber
from openhands.storage.memory import InMemoryFileStore
from openhands.events.action import MessageAction, CmdRunAction, FileEditAction
from openhands.events.event import Event
from openhands.events.observation import (
    CmdOutputObservation,
    FileEditObservation,
    AgentStateChangedObservation,
    ErrorObservation,
)
from openhands.llm.llm_registry import LLMRegistry
from openhands.runtime.impl.local.local_runtime import LocalRuntime
from openhands.server.services.conversation_stats import ConversationStats

from app.config import QingCodeConfig
from app.models.schemas import (
    ConversationStatus,
    MessageRole,
    WSEvent,
    WSEventType,
)
from app.storage.database import Database

logger = logging.getLogger("qingcode.engine")

EventCallback = Callable[[WSEvent], Coroutine[Any, Any, None]]


def _uuid() -> str:
    return uuid.uuid4().hex[:16]


class _ConversationHandle:
    """Manages one OpenHands agent conversation."""

    def __init__(
        self,
        conversation_id: str,
        workspace_path: str,
        oh_config: OpenHandsConfig,
        db: Database,
        on_event: EventCallback,
    ) -> None:
        self.conversation_id = conversation_id
        self.workspace_path = workspace_path
        self.oh_config = oh_config
        self.db = db
        self.on_event = on_event
        self._controller: AgentController | None = None
        self._event_stream: EventStream | None = None
        self._runtime: LocalRuntime | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopped = False

    async def _emit(self, event_type: WSEventType, payload: dict[str, Any]) -> None:
        event = WSEvent(
            event_id=_uuid(),
            conversation_id=self.conversation_id,
            type=event_type,
            payload=payload,
        )
        try:
            await self.on_event(event)
        except Exception:
            logger.exception("Failed to emit event %s", event_type)

    def _map_oh_event(self, event: Event) -> None:
        """Convert OpenHands event to QingCode WSEvent and schedule emit."""
        loop = asyncio.get_event_loop()

        if isinstance(event, MessageAction):
            if event.source == "agent":
                msg_id = _uuid()
                self.db.add_message(
                    msg_id, self.conversation_id, "assistant", event.content,
                )
                loop.create_task(self._emit(WSEventType.agent_message, {
                    "message_id": msg_id,
                    "content": event.content,
                }))
                loop.create_task(self._emit(WSEventType.agent_message_end, {
                    "message_id": msg_id,
                }))

        elif isinstance(event, CmdRunAction):
            loop.create_task(self._emit(WSEventType.action, {
                "action_type": "terminal",
                "command": event.command,
            }))

        elif isinstance(event, CmdOutputObservation):
            loop.create_task(self._emit(WSEventType.terminal_output, {
                "output": event.content,
                "exit_code": getattr(event, "exit_code", None),
            }))
            loop.create_task(self._emit(WSEventType.observation, {
                "observation_type": "terminal",
                "content": event.content,
            }))

        elif isinstance(event, FileEditAction):
            loop.create_task(self._emit(WSEventType.action, {
                "action_type": "file_edit",
                "path": getattr(event, "path", ""),
            }))

        elif isinstance(event, FileEditObservation):
            loop.create_task(self._emit(WSEventType.file_change, {
                "path": getattr(event, "path", ""),
                "content": event.content[:2000] if event.content else "",
            }))
            loop.create_task(self._emit(WSEventType.observation, {
                "observation_type": "file_edit",
                "content": event.content[:2000] if event.content else "",
            }))

        elif isinstance(event, ErrorObservation):
            loop.create_task(self._emit(WSEventType.error, {
                "message": event.content,
            }))

        elif isinstance(event, AgentStateChangedObservation):
            state_str = str(getattr(event, "agent_state", "unknown"))
            loop.create_task(self._emit(WSEventType.status, {
                "status": state_str,
            }))

    async def start(self) -> None:
        """Initialize the OpenHands runtime and controller."""
        sid = _uuid()
        self._event_stream = EventStream(sid=sid, file_store=InMemoryFileStore())
        self._event_stream.subscribe(EventStreamSubscriber.MAIN, self._map_oh_event, callback_id="qingcode")

        # Create LLM registry first — needed by both runtime and agent
        llm_registry = LLMRegistry(config=self.oh_config)

        self._runtime = LocalRuntime(
            config=self.oh_config,
            event_stream=self._event_stream,
            llm_registry=llm_registry,
            sid=sid,
        )
        await self._runtime.connect()
        agent_cls = Agent.get_cls(self.oh_config.default_agent)
        agent_config = self.oh_config.agents.get(
            self.oh_config.default_agent, AgentConfig()
        )
        agent = agent_cls(config=agent_config, llm_registry=llm_registry)

        conversation_stats = ConversationStats(
            file_store=None,
            conversation_id=self.conversation_id,
            user_id=None,
        )

        self._controller = AgentController(
            agent=agent,
            event_stream=self._event_stream,
            conversation_stats=conversation_stats,
            iteration_delta=self.oh_config.max_iterations,
            sid=sid,
        )

    async def send_message(self, content: str) -> None:
        """Send a user message and trigger the agent loop."""
        if self._stopped or not self._event_stream or not self._controller:
            raise RuntimeError("Conversation not active")

        msg_id = _uuid()
        self.db.add_message(msg_id, self.conversation_id, "user", content)

        action = MessageAction(content=content, source="user")
        self._event_stream.add_event(action)

        await self._emit(WSEventType.status, {"status": "active"})
        self.db.update_conversation(self.conversation_id, status="active")

        self._task = asyncio.create_task(self._run_agent_loop())

    async def _run_agent_loop(self) -> None:
        """Run the agent controller step loop until completion."""
        try:
            ctrl = self._controller
            if not ctrl:
                return
            while True:
                agent_state = ctrl.get_agent_state()
                if agent_state == AgentState.FINISHED:
                    break
                if hasattr(AgentState, "ERROR") and agent_state == AgentState.ERROR:
                    break
                if hasattr(AgentState, "REJECTED") and agent_state == AgentState.REJECTED:
                    break
                if hasattr(AgentState, "STOPPED") and agent_state == AgentState.STOPPED:
                    break
                ctrl.step()
                await asyncio.sleep(0)  # yield to event loop
            final_state = ctrl.get_agent_state()
            status = "completed" if final_state == AgentState.FINISHED else "error"
            self.db.update_conversation(self.conversation_id, status=status)
            await self._emit(WSEventType.status, {"status": status})
        except asyncio.CancelledError:
            self.db.update_conversation(self.conversation_id, status="paused")
            await self._emit(WSEventType.status, {"status": "paused"})
        except Exception as exc:
            logger.exception("Agent loop error for %s", self.conversation_id)
            self.db.update_conversation(self.conversation_id, status="error")
            await self._emit(WSEventType.error, {"message": str(exc)})
            await self._emit(WSEventType.status, {"status": "error"})

    async def stop(self) -> None:
        self._stopped = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._runtime:
            try:
                await self._runtime.close()
            except Exception:
                pass


class QingCodeEngine:
    """Top-level engine managing all QingCode conversations."""

    def __init__(self, config: QingCodeConfig, db: Database, on_event: EventCallback) -> None:
        self._config = config
        self._db = db
        self._on_event = on_event
        self._handles: dict[str, _ConversationHandle] = {}

    def _build_oh_config(
        self, workspace_path: str, model: str, base_url: str, api_key: str,
    ) -> OpenHandsConfig:
        ws = workspace_path or str(Path.home())
        return OpenHandsConfig(
            llms={"default": LLMConfig(
                model=model,
                base_url=base_url,
                api_key=SecretStr(api_key),
            )},
            agents={"CodeActAgent": AgentConfig()},
            default_agent="CodeActAgent",
            sandbox=SandboxConfig(
                use_host_network=True,
            ),
            runtime="local",
            workspace_base=ws,
            workspace_mount_path=ws,
            max_iterations=self._config.max_iterations,
        )

    async def create_conversation(
        self,
        conversation_id: str,
        workspace_path: str,
        model: str,
        base_url: str,
        api_key: str,
    ) -> None:
        oh_config = self._build_oh_config(workspace_path, model, base_url, api_key)
        handle = _ConversationHandle(
            conversation_id=conversation_id,
            workspace_path=workspace_path,
            oh_config=oh_config,
            db=self._db,
            on_event=self._on_event,
        )
        await handle.start()
        self._handles[conversation_id] = handle

    async def send_message(self, conversation_id: str, content: str) -> None:
        handle = self._handles.get(conversation_id)
        if not handle:
            raise KeyError(f"Conversation {conversation_id} not found")
        await handle.send_message(content)

    async def stop_conversation(self, conversation_id: str) -> None:
        handle = self._handles.pop(conversation_id, None)
        if handle:
            await handle.stop()

    async def shutdown(self) -> None:
        for cid in list(self._handles):
            await self.stop_conversation(cid)

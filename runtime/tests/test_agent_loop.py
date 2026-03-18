import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from app.agent import AgentLoop
from app.models import (
    AgentAction,
    AgentActionKind,
    AgentSessionConfig,
    CapabilityGrants,
    EventKind,
    MessageRole,
    PolicyDecision,
    PolicyVerdict,
    RiskLevel,
    SessionRecord,
    SessionStatus,
)


@dataclass
class FakeLiveSession:
    record: SessionRecord


class FakeProvider:
    def __init__(self, actions: list[AgentAction]) -> None:
        self._actions = actions
        self.calls = 0

    async def next_action(self, context: dict[str, object], on_chunk=None) -> AgentAction:
        self.calls += 1
        return self._actions[self.calls - 1]


class FakePolicy:
    def evaluate(self, _context, _action: AgentAction) -> PolicyDecision:
        return PolicyDecision(
            verdict=PolicyVerdict.ALLOW,
            risk_level=RiskLevel.LOW,
            reason="safe",
        )


class FakeManager:
    def __init__(self, home: Path, actions: list[AgentAction], execution_errors: list[Exception]) -> None:
        self.provider = FakeProvider(actions)
        self.policy = FakePolicy()
        self.record = SessionRecord(
            config=AgentSessionConfig(
                cwd=str(home),
                grants=CapabilityGrants(terminal=True, filesystem=True, browser=True),
            ),
            current_cwd=str(home),
        )
        self.messages: list[tuple[MessageRole, str, dict[str, object] | None]] = []
        self.statuses: list[SessionStatus] = []
        self.errors: list[str] = []
        self.ephemeral_events: list[tuple[EventKind, dict[str, object]]] = []
        self.streamed_replies: list[tuple[str, str]] = []
        self.execution_errors = execution_errors

    def require_session(self, _session_id: str) -> FakeLiveSession:
        return FakeLiveSession(record=self.record)

    async def set_status(self, _session_id: str, status: SessionStatus) -> None:
        self.record.status = status
        self.statuses.append(status)

    def build_provider_context(
        self,
        _session_id: str,
        *,
        loop_state: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return {"loop_state": loop_state or {}}

    async def publish_error(self, _session_id: str, message: str) -> None:
        self.errors.append(message)

    async def publish_ephemeral_event(self, _session_id: str, kind, payload: dict[str, object]) -> None:
        self.ephemeral_events.append((kind, payload))

    async def add_message(
        self,
        _session_id: str,
        role: MessageRole,
        content: str,
        metadata: dict[str, object] | None = None,
        message_id: str | None = None,
    ) -> None:
        self.messages.append((role, content, metadata))

    async def publish_policy_decision(self, _session_id: str, _action: AgentAction, _decision: PolicyDecision) -> None:
        return None

    async def create_approval(self, _session_id: str, _action: AgentAction, _decision: PolicyDecision) -> None:
        raise AssertionError("approval path should not be used in this test")

    async def execute_action(self, _session_id: str, _action: AgentAction) -> dict[str, object]:
        if self.execution_errors:
            raise self.execution_errors.pop(0)
        return {"ok": True}

    async def stream_assistant_reply(
        self,
        _session_id: str,
        *,
        message_id: str,
        content: str,
        chunk_delay_ms: int = 14,
    ) -> None:
        self.streamed_replies.append((message_id, content))
        await self.publish_ephemeral_event(_session_id, EventKind.ASSISTANT_STREAM_START, {"message_id": message_id})
        await self.publish_ephemeral_event(_session_id, EventKind.ASSISTANT_CHUNK, {"message_id": message_id, "chunk": content})
        await self.publish_ephemeral_event(_session_id, EventKind.ASSISTANT_STREAM_END, {"message_id": message_id})


@pytest.mark.asyncio
async def test_langgraph_loop_replans_after_action_error(tmp_path: Path) -> None:
    manager = FakeManager(
        tmp_path,
        actions=[
            AgentAction(kind=AgentActionKind.BROWSER_CLICK, args={"selector": "text=登录"}),
            AgentAction(kind=AgentActionKind.FINAL_ANSWER, args={"content": "Recovered after retry."}),
        ],
        execution_errors=[RuntimeError("Locator.click intercepted by dialog")],
    )

    await AgentLoop(max_steps=4, max_action_retries=2).run(manager, manager.record.session_id)

    assert manager.provider.calls == 2
    tool_messages = [json.loads(content) for role, content, _ in manager.messages if role == MessageRole.TOOL]
    assert tool_messages[0]["action_error"]["kind"] == AgentActionKind.BROWSER_CLICK.value
    assert tool_messages[0]["error"] == "Locator.click intercepted by dialog"
    assert manager.messages[-1][0] == MessageRole.ASSISTANT
    assert manager.messages[-1][1] == "Recovered after retry."
    assert manager.statuses[-1] == SessionStatus.AUTHORIZED


@pytest.mark.asyncio
async def test_langgraph_loop_streams_final_answer_lifecycle(tmp_path: Path) -> None:
    manager = FakeManager(
        tmp_path,
        actions=[
            AgentAction(kind=AgentActionKind.FINAL_ANSWER, args={"content": "Streaming answer."}),
        ],
        execution_errors=[],
    )

    await AgentLoop(max_steps=2, max_action_retries=1).run(manager, manager.record.session_id)

    assert manager.streamed_replies
    message_id, content = manager.streamed_replies[0]
    assert content == "Streaming answer."
    kinds = [kind for kind, payload in manager.ephemeral_events if payload.get("message_id") == message_id]
    assert kinds == [EventKind.ASSISTANT_STREAM_START, EventKind.ASSISTANT_CHUNK, EventKind.ASSISTANT_STREAM_END]
    assert manager.messages[-1][1] == "Streaming answer."

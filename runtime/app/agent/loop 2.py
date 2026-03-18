from __future__ import annotations

import json
from typing import TYPE_CHECKING

from app.models import AgentActionKind, MessageRole, PolicyVerdict, SessionStatus
from app.policy import PolicyContext

if TYPE_CHECKING:
    from app.session.manager import SessionManager


class AgentLoop:
    def __init__(self, max_steps: int = 12) -> None:
        self._max_steps = max_steps

    async def run(self, manager: "SessionManager", session_id: str) -> None:
        live_session = manager.require_session(session_id)
        await manager.set_status(session_id, SessionStatus.ACTIVE)
        for _ in range(self._max_steps):
            live_session = manager.require_session(session_id)
            if live_session.record.pending_approval_id:
                return
            context = manager.build_provider_context(session_id)
            try:
                action = await manager.provider.next_action(context)
            except Exception as exc:
                await manager.publish_error(session_id, f"Provider failure: {exc}")
                await manager.add_message(
                    session_id,
                    MessageRole.ASSISTANT,
                    f"Provider error: {exc}",
                )
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return

            decision = manager.policy.evaluate(PolicyContext(session=live_session.record), action)
            await manager.publish_policy_decision(session_id, action, decision)

            if action.kind == AgentActionKind.FINAL_ANSWER:
                content = str(action.args.get("content") or action.summary or "")
                await manager.add_message(session_id, MessageRole.ASSISTANT, content)
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return

            if decision.verdict == PolicyVerdict.DENY:
                await manager.add_message(
                    session_id,
                    MessageRole.TOOL,
                    json.dumps({"action_denied": action.model_dump(mode="json"), "reason": decision.reason}, ensure_ascii=True),
                    {"denied": True},
                )
                continue

            if decision.verdict == PolicyVerdict.REQUIRE_APPROVAL:
                await manager.create_approval(session_id, action, decision)
                await manager.set_status(session_id, SessionStatus.PAUSED)
                return

            try:
                await manager.execute_action(session_id, action)
            except Exception as exc:
                await manager.publish_error(session_id, f"Action execution failure: {exc}")
                await manager.add_message(
                    session_id,
                    MessageRole.TOOL,
                    json.dumps({"action_error": action.model_dump(mode="json"), "error": str(exc)}, ensure_ascii=True),
                    {"execution_error": True},
                )
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return
        await manager.publish_error(session_id, "Agent loop reached the maximum number of steps for a single turn.")
        await manager.add_message(
            session_id,
            MessageRole.ASSISTANT,
            "I stopped after reaching the step limit for this turn. You can continue with a more specific prompt.",
        )
        await manager.set_status(session_id, SessionStatus.AUTHORIZED)

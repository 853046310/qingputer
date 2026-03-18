from __future__ import annotations

import json
from typing import Literal, TypedDict
from uuid import uuid4

from langgraph.graph import END, START, StateGraph

from app.models import AgentAction, AgentActionKind, EventKind, MessageRole, PolicyVerdict, SessionStatus
from app.policy import PolicyContext


class LoopState(TypedDict, total=False):
    session_id: str
    step_count: int
    retry_count: int
    last_error: str | None
    action: AgentAction | None
    streaming_message_id: str | None
    terminal_state: Literal[
        "planning",
        "planned",
        "continue",
        "replan",
        "awaiting_approval",
        "provider_error",
        "step_limit",
        "execution_failed",
        "finished",
    ]


class AgentLoop:
    def __init__(self, max_steps: int = 12, max_action_retries: int = 2) -> None:
        self._max_steps = max_steps
        self._max_action_retries = max_action_retries

    async def run(self, manager, session_id: str) -> None:
        await manager.set_status(session_id, SessionStatus.ACTIVE)
        graph = self._build_graph(manager)
        initial_state: LoopState = {
            "session_id": session_id,
            "step_count": 0,
            "retry_count": 0,
            "last_error": None,
            "terminal_state": "planning",
            "action": None,
        }
        await graph.ainvoke(
            initial_state,
            config={"recursion_limit": max(32, (self._max_steps * 4) + (self._max_action_retries * 3) + 8)},
        )

    def _build_graph(self, manager):
        workflow = StateGraph(LoopState)

        async def plan(state: LoopState) -> LoopState:
            session_id = state["session_id"]
            live_session = manager.require_session(session_id)
            if live_session.record.pending_approval_id:
                return {"terminal_state": "awaiting_approval"}
            if state.get("step_count", 0) >= self._max_steps:
                await manager.publish_error(session_id, "Agent loop reached the maximum number of steps for a single turn.")
                await manager.add_message(
                    session_id,
                    MessageRole.ASSISTANT,
                    "I stopped after reaching the step limit for this turn. You can continue with a more specific prompt.",
                )
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return {"terminal_state": "step_limit"}

            context = manager.build_provider_context(
                session_id,
                loop_state={
                    "step_count": state.get("step_count", 0),
                    "retry_count": state.get("retry_count", 0),
                    "remaining_steps": max(self._max_steps - state.get("step_count", 0), 0),
                    "remaining_action_retries": max(self._max_action_retries - state.get("retry_count", 0), 0),
                    "last_error": state.get("last_error"),
                },
            )
            streaming_message_id = str(uuid4())

            try:
                action = await manager.provider.next_action(context)
            except Exception as exc:
                error_text = self._describe_exception(exc)
                await manager.publish_error(session_id, f"Provider failure: {error_text}")
                await manager.add_message(
                    session_id,
                    MessageRole.ASSISTANT,
                    f"Provider error: {error_text}",
                )
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return {"terminal_state": "provider_error", "last_error": error_text}

            return {
                "action": action,
                "step_count": state.get("step_count", 0) + 1,
                "terminal_state": "planned",
                "streaming_message_id": streaming_message_id,
            }

        async def finalize(state: LoopState) -> LoopState:
            session_id = state["session_id"]
            action = state.get("action")
            streaming_message_id = state.get("streaming_message_id")
            content = ""
            if action is not None:
                content = str(action.args.get("content") or action.summary or "")
            if streaming_message_id:
                await manager.stream_assistant_reply(
                    session_id,
                    message_id=streaming_message_id,
                    content=content,
                )
            await manager.add_message(
                session_id,
                MessageRole.ASSISTANT,
                content,
                message_id=streaming_message_id,
            )
            await manager.set_status(session_id, SessionStatus.AUTHORIZED)
            return {"terminal_state": "finished"}

        async def apply_policy(state: LoopState) -> LoopState:
            session_id = state["session_id"]
            action = state.get("action")
            if action is None:
                await manager.publish_error(session_id, "Policy evaluation failure: Missing agent action.")
                await manager.add_message(
                    session_id,
                    MessageRole.ASSISTANT,
                    "I stopped because the next action was missing from runtime state before policy evaluation.",
                )
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return {"terminal_state": "execution_failed", "last_error": "Missing agent action."}

            live_session = manager.require_session(session_id)
            decision = manager.policy.evaluate(PolicyContext(session=live_session.record), action)
            await manager.publish_policy_decision(session_id, action, decision)

            if decision.verdict == PolicyVerdict.DENY:
                await manager.add_message(
                    session_id,
                    MessageRole.TOOL,
                    json.dumps({"action_denied": action.model_dump(mode="json"), "reason": decision.reason}, ensure_ascii=True),
                    {
                        "denied": True,
                        "action_kind": action.kind.value,
                        "action_summary": action.summary,
                        "server_id": action.args.get("server_id"),
                        "tool_name": action.args.get("tool_name"),
                    },
                )
                return {"terminal_state": "replan", "last_error": decision.reason, "action": None}

            if decision.verdict == PolicyVerdict.REQUIRE_APPROVAL:
                await manager.create_approval(session_id, action, decision)
                await manager.set_status(session_id, SessionStatus.PAUSED)
                return {"terminal_state": "awaiting_approval"}

            return {"terminal_state": "continue"}

        async def execute(state: LoopState) -> LoopState:
            session_id = state["session_id"]
            action = state.get("action")
            if action is None:
                await manager.publish_error(session_id, "Action execution failure: Missing action in graph state.")
                await manager.add_message(
                    session_id,
                    MessageRole.ASSISTANT,
                    "I stopped because the next action could not be recovered from runtime state.",
                )
                await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                return {"terminal_state": "execution_failed", "last_error": "Missing action in graph state."}

            try:
                await manager.execute_action(session_id, action)
            except Exception as exc:
                error_text = str(exc)
                await manager.publish_error(session_id, f"Action execution failure: {error_text}")
                await manager.add_message(
                    session_id,
                    MessageRole.TOOL,
                    json.dumps({"action_error": action.model_dump(mode="json"), "error": error_text}, ensure_ascii=True),
                    {
                        "execution_error": True,
                        "action_kind": action.kind.value,
                        "action_summary": action.summary,
                        "server_id": action.args.get("server_id"),
                        "tool_name": action.args.get("tool_name"),
                    },
                )
                retry_count = state.get("retry_count", 0) + 1
                if retry_count > self._max_action_retries:
                    await manager.add_message(
                        session_id,
                        MessageRole.ASSISTANT,
                        "I stopped after repeated action failures. Please refine the task or intervene manually.",
                    )
                    await manager.set_status(session_id, SessionStatus.AUTHORIZED)
                    return {
                        "terminal_state": "execution_failed",
                        "retry_count": retry_count,
                        "last_error": error_text,
                        "action": None,
                    }
                return {
                    "terminal_state": "replan",
                    "retry_count": retry_count,
                    "last_error": error_text,
                    "action": None,
                }

            return {
                "terminal_state": "continue",
                "retry_count": 0,
                "last_error": None,
                "action": None,
            }

        def route_after_plan(state: LoopState) -> str:
            terminal_state = state.get("terminal_state")
            if terminal_state in {"awaiting_approval", "provider_error", "step_limit"}:
                return "end"
            action = state.get("action")
            if action is not None and action.kind == AgentActionKind.FINAL_ANSWER:
                return "finalize"
            return "policy"

        def route_after_policy(state: LoopState) -> str:
            terminal_state = state.get("terminal_state")
            if terminal_state == "execution_failed":
                return "end"
            if terminal_state == "awaiting_approval":
                return "end"
            if terminal_state == "replan":
                return "plan"
            return "execute"

        def route_after_execute(state: LoopState) -> str:
            terminal_state = state.get("terminal_state")
            if terminal_state in {"execution_failed", "finished"}:
                return "end"
            return "plan"

        workflow.add_node("plan", plan)
        workflow.add_node("finalize", finalize)
        workflow.add_node("policy", apply_policy)
        workflow.add_node("execute", execute)

        workflow.add_edge(START, "plan")
        workflow.add_conditional_edges(
            "plan",
            route_after_plan,
            {
                "policy": "policy",
                "finalize": "finalize",
                "end": END,
            },
        )
        workflow.add_conditional_edges(
            "policy",
            route_after_policy,
            {
                "plan": "plan",
                "execute": "execute",
                "end": END,
            },
        )
        workflow.add_conditional_edges(
            "execute",
            route_after_execute,
            {
                "plan": "plan",
                "end": END,
            },
        )
        workflow.add_edge("finalize", END)

        return workflow.compile()

    @staticmethod
    def _describe_exception(exc: Exception) -> str:
        detail = str(exc).strip()
        if detail:
            return detail
        return type(exc).__name__

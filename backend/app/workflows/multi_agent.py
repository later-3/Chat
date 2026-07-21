"""Governed MAF Workflow that hands a full conversation across two Agents."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any, Callable

from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler, response_handler
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..agent_profiles import AgentProfileSnapshot
from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)
from ..model_call_workflow import ProviderTransport, normalize_agui_messages_for_provider
from ..product_sessions.service import ProductSessionService


@dataclass(frozen=True, slots=True)
class AgentTurnEnvelope:
    messages: tuple[dict[str, Any], ...]
    origin_prompt: str
    source_agent_id: str
    source_agent_name: str


@dataclass(frozen=True, slots=True)
class AgentTurnRequest:
    messages: tuple[dict[str, Any], ...]
    origin_prompt: str


class GovernedAgentExecutor(Executor, RequestInfoMixin):
    """Agent-shaped node whose exact provider call must be approved first."""

    def __init__(
        self,
        *,
        profile: AgentProfileSnapshot,
        position: int,
        final: bool,
        thread_id: str,
        run_id: Callable[[], str],
        store: InMemoryModelCallReviewStore,
        transport: ProviderTransport,
        sessions: ProductSessionService,
    ) -> None:
        super().__init__(id=profile.id)
        self.profile = profile
        self.position = position
        self.final = final
        self._thread_id = thread_id
        self._run_id = run_id
        self._store = store
        self._transport = transport
        self._sessions = sessions

    @property
    def description(self) -> str:
        return self.profile.description

    @property
    def output_types(self) -> list[type[Any]]:
        return [str] if self.final else [AgentTurnEnvelope]

    async def _request_review(
        self,
        messages: list[dict[str, Any]],
        origin_prompt: str,
        ctx: WorkflowContext[Any, Any],
    ) -> None:
        draft = self._store.begin(
            thread_id=self._thread_id,
            run_id=self._run_id(),
            messages=messages,
            model=self.profile.model,
            provider_id=self.profile.provider_id,
            instructions=self.profile.instructions,
            origin_prompt=origin_prompt,
            execution_context={
                "workflow_id": "governed-agent-handoff",
                "agent_id": self.profile.id,
                "agent_name": self.profile.name,
                "agent_revision": self.profile.revision,
                "call_position": self.position,
                "total_calls": 2,
            },
        )
        await self._sessions.mark_waiting_approval(
            self._thread_id,
            draft_id=draft.draft_id,
            approval_id=draft.approval_id,
        )
        await ctx.request_info(draft.review_card(), dict, request_id=draft.approval_id)

    @handler(input=list)
    async def from_agui_messages(self, messages: list[Any], ctx) -> None:
        normalized = normalize_agui_messages_for_provider(messages)
        if not normalized:
            raise ValueError("Agent Workflow没有可发送的会话消息")
        origin_prompt = next(
            (
                str(part.get("text") or "")
                for message in reversed(normalized)
                if message.get("role") == "user"
                for part in message.get("content", [])
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ),
            "",
        )
        await self._request_review(normalized, origin_prompt, ctx)

    @handler(input=AgentTurnRequest)
    async def from_handoff(self, request: AgentTurnRequest, ctx) -> None:
        await self._request_review(list(request.messages), request.origin_prompt, ctx)

    async def _dispatch(self, approval_id: str, binding_hash: str) -> str:
        try:
            await self._sessions.mark_running(self._thread_id)
            draft = self._store.claim(
                approval_id=approval_id,
                expected_hash=binding_hash,
                owner=f"api-pid-{os.getpid()}:{self.profile.id}",
            )
        except ModelCallDraftConflict:
            return ""

        chunks: list[str] = []
        try:
            async for text in self._transport.stream(PreparedProviderRequest.from_draft(draft)):
                chunks.append(text)
        except ProviderDispatchError as error:
            self._store.mark_attempt(
                approval_id,
                error.outcome_status,
                error_code=error.error_code,
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status=error.outcome_status,
                error_code=error.error_code,
                message=str(error),
            )
            raise
        except asyncio.CancelledError:
            self._store.mark_attempt(
                approval_id,
                "outcome_unknown",
                error_code="provider_dispatch_cancelled",
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status="outcome_unknown",
                error_code="provider_dispatch_cancelled",
                message="Provider发送期间被取消，结果未知。",
            )
            raise
        self._store.mark_attempt(approval_id, "completed")
        return "".join(chunks) or "模型调用已完成，但没有返回可显示的文本。"

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        action = decision.get("decision")
        if action == "revise":
            revised = self._store.successor(
                str(original_request["draft_id"]),
                str(decision["revision_draft_id"]),
            )
            await self._sessions.mark_waiting_approval(
                self._thread_id,
                draft_id=revised.draft_id,
                approval_id=revised.approval_id,
            )
            await ctx.request_info(revised.review_card(), dict, request_id=revised.approval_id)
            return
        if action == "abandon":
            self._store.abandon(str(original_request["approval_id"]))
            await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("本次多Agent Workflow已放弃，未继续调用模型。")
            return
        if action != "approve":
            raise ValueError(f"不支持的模型调用审批决定: {action}")

        text = await self._dispatch(
            str(original_request["approval_id"]),
            str(original_request["binding_hash"]),
        )
        if not text:
            await ctx.yield_output("该审批已失效或已被处理，没有重复发送模型请求。")
            return
        if self.final:
            await ctx.yield_output(text)
            return

        request_messages = original_request.get("provider_request", {}).get(
            "input",
            original_request.get("provider_request", {}).get("messages", []),
        )
        messages = [
            dict(value)
            for value in request_messages
            if isinstance(value, dict) and value.get("role") != "system"
        ]
        messages.append({"role": "assistant", "content": text})
        await ctx.send_message(
            AgentTurnEnvelope(
                messages=tuple(messages),
                origin_prompt=str(original_request.get("origin_prompt") or ""),
                source_agent_id=self.profile.id,
                source_agent_name=self.profile.name,
            )
        )


class HandoffExecutor(Executor):
    def __init__(self) -> None:
        super().__init__(id="handoff")

    @handler
    async def transfer(
        self,
        envelope: AgentTurnEnvelope,
        ctx: WorkflowContext[AgentTurnRequest],
    ) -> None:
        messages = list(envelope.messages)
        messages.append(
            {
                "role": "user",
                "content": (
                    f"这是来自{envelope.source_agent_name}（{envelope.source_agent_id}）的显式交接。"
                    "请保留原始用户目标，复核上一条Agent草稿并给出最终答复。"
                ),
            }
        )
        await ctx.send_message(
            AgentTurnRequest(messages=tuple(messages), origin_prompt=envelope.origin_prompt)
        )


def create_governed_agent_handoff_workflow(
    *,
    thread_id: str,
    run_id: Callable[[], str],
    planner: AgentProfileSnapshot,
    reviewer: AgentProfileSnapshot,
    store: InMemoryModelCallReviewStore,
    transport: ProviderTransport,
    sessions: ProductSessionService,
):
    planner_executor = GovernedAgentExecutor(
        profile=planner,
        position=1,
        final=False,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
    )
    handoff = HandoffExecutor()
    reviewer_executor = GovernedAgentExecutor(
        profile=reviewer,
        position=2,
        final=True,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
    )
    return (
        WorkflowBuilder(
            name="governed-agent-handoff",
            start_executor=planner_executor,
            output_from=[reviewer_executor],
        )
        .add_edge(planner_executor, handoff)
        .add_edge(handoff, reviewer_executor)
        .build()
    )

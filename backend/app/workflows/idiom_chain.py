"""Governed three-party idiom-chain Workflow with two model approvals."""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable

from agent_framework import (
    Executor,
    WorkflowBuilder,
    WorkflowContext,
    handler,
    response_handler,
)
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..agent_profiles import AgentProfileSnapshot
from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)
from ..model_call_workflow import (
    ProviderTransport,
    normalize_agui_messages_for_provider,
)
from ..product_sessions.service import ProductSessionService

WORKFLOW_ID = "governed-idiom-chain"
FOUR_CHINESE = re.compile(r"[\u4e00-\u9fff]{4}")
QUOTED_FOUR_CHINESE = re.compile(r"[“\"']([\u4e00-\u9fff]{4})[”\"']")
NEXT_TURN = re.compile(r"请用[“\"]([\u4e00-\u9fff])[”\"]字开头继续")


@dataclass(frozen=True, slots=True)
class IdiomRoundState:
    origin_prompt: str
    user_idiom: str
    required_start: str | None = None
    agent_a_idiom: str | None = None
    agent_b_idiom: str | None = None


def _content_text(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(part.get("text") or "")
        for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def extract_idiom(text: str) -> str:
    clean = text.strip().strip("`。！!，,；;：:")
    if FOUR_CHINESE.fullmatch(clean):
        return clean
    quoted = QUOTED_FOUR_CHINESE.search(text)
    if quoted:
        return quoted.group(1)
    raise ValueError("成语接龙需要只输入一个四字中文成语")


def validate_chain(idiom: str, required_start: str | None, actor: str) -> None:
    if required_start is not None and not idiom.startswith(required_start):
        raise ValueError(f"{actor}需要用“{required_start}”字开头，实际得到“{idiom}”")


class IdiomTraceMixin:
    def _trace_init(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
    ) -> None:
        self._thread_id = thread_id
        self._sessions = sessions

    async def _content_trace(
        self,
        *,
        executor_id: str,
        public_input: Any,
        public_output: Any,
        actor: str,
        content_type: str = "idiom_chain",
    ) -> None:
        active = await self._sessions.active_run(self._thread_id)
        if active is None:
            return
        await self._sessions.record_trace(
            self._thread_id,
            str(active["id"]),
            "workflow.node.content",
            {
                "workflow_id": WORKFLOW_ID,
                "executor_id": executor_id,
                "actor": actor,
                "content_type": content_type,
                "public_input": public_input,
                "public_output": public_output,
            },
        )

    async def _abandoned_trace(self, executor_id: str) -> None:
        active = await self._sessions.active_run(self._thread_id)
        if active is None:
            return
        await self._sessions.record_trace(
            self._thread_id,
            str(active["id"]),
            "workflow.node",
            {
                "workflow_id": WORKFLOW_ID,
                "executor_id": executor_id,
                "status": "abandoned",
                "details": {"message": "用户放弃了这个Agent的模型调用。"},
            },
        )


class IdiomInputExecutor(Executor, IdiomTraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="idiom_input")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=list)
    async def parse(self, messages: list[Any], ctx: WorkflowContext[IdiomRoundState]) -> None:
        normalized = normalize_agui_messages_for_provider(messages)
        user_messages = [value for value in normalized if value.get("role") == "user"]
        if not user_messages:
            raise ValueError("成语接龙没有收到用户输入")
        origin_prompt = _content_text(user_messages[-1]).strip()
        user_idiom = extract_idiom(origin_prompt)

        required_start: str | None = None
        for value in reversed(normalized[:-1]):
            if value.get("role") != "assistant":
                continue
            match = NEXT_TURN.search(_content_text(value))
            if match:
                required_start = match.group(1)
                break
        validate_chain(user_idiom, required_start, "你本轮的成语")
        state = IdiomRoundState(
            origin_prompt=origin_prompt,
            user_idiom=user_idiom,
            required_start=required_start,
        )
        await self._content_trace(
            executor_id=self.id,
            actor="user",
            public_input=origin_prompt,
            public_output={
                "user_idiom": user_idiom,
                "required_start": required_start or "本轮自由起始",
                "next_required_start": user_idiom[-1],
            },
        )
        await ctx.send_message(state)


class IdiomAgentExecutor(Executor, RequestInfoMixin, IdiomTraceMixin):
    def __init__(
        self,
        *,
        profile: AgentProfileSnapshot,
        position: int,
        thread_id: str,
        run_id: Callable[[], str],
        store: InMemoryModelCallReviewStore,
        transport: ProviderTransport,
        sessions: ProductSessionService,
    ) -> None:
        super().__init__(id=profile.id)
        self.profile = profile
        self.position = position
        self._run_id = run_id
        self._store = store
        self._transport = transport
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @property
    def description(self) -> str:
        return self.profile.description

    @handler(input=IdiomRoundState)
    async def prepare(self, state: IdiomRoundState, ctx) -> None:
        previous = state.user_idiom if self.position == 1 else state.agent_a_idiom
        if previous is None:
            raise ValueError("成语接龙状态缺少上一棒")
        required_start = previous[-1]
        visible_prompt = (
            f"我们正在进行三方四字成语同字接龙。上一棒是“{previous}”。"
            f"你是第{self.position}位Agent，请只回复一个以“{required_start}”字开头的四字成语，"
            "不要解释、不要标点、不要重复上一棒。"
        )
        history = [
            {"role": "user", "content": state.origin_prompt},
            {"role": "assistant", "content": f"玩家本轮成语：{state.user_idiom}"},
        ]
        if state.agent_a_idiom is not None:
            history.append({"role": "assistant", "content": f"接龙Agent甲：{state.agent_a_idiom}"})
        history.append({"role": "user", "content": visible_prompt})
        draft = self._store.begin(
            thread_id=self._thread_id,
            run_id=self._run_id(),
            messages=history,
            model=self.profile.model,
            provider_id=self.profile.provider_id,
            instructions=self.profile.instructions,
            origin_prompt=state.origin_prompt,
            execution_context={
                "workflow_id": WORKFLOW_ID,
                "agent_id": self.profile.id,
                "agent_name": self.profile.name,
                "agent_revision": self.profile.revision,
                "call_position": self.position,
                "total_calls": 2,
                "executor_id": self.id,
                "chain_state": asdict(state),
                "required_start": required_start,
            },
        )
        await self._content_trace(
            executor_id=self.id,
            actor=self.profile.name,
            public_input={
                "previous_idiom": previous,
                "required_start": required_start,
                "task": visible_prompt,
            },
            public_output="等待本次模型请求审批后生成",
        )
        await self._sessions.mark_waiting_approval(
            self._thread_id,
            draft_id=draft.draft_id,
            approval_id=draft.approval_id,
        )
        await ctx.request_info(draft.review_card(), dict, request_id=draft.approval_id)

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
            self._store.mark_attempt(approval_id, error.outcome_status, error_code=error.error_code)
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
        return "".join(chunks)

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
            await self._abandoned_trace(self.id)
            self._store.abandon(str(original_request["approval_id"]))
            await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("本次成语接龙已放弃，当前Agent没有向模型发送内容。")
            return
        if action != "approve":
            raise ValueError(f"不支持的模型调用审批决定: {action}")

        text = await self._dispatch(
            str(original_request["approval_id"]),
            str(original_request["binding_hash"]),
        )
        if not text:
            await ctx.yield_output("该审批已失效或模型没有返回成语，接龙未继续。")
            return
        idiom = extract_idiom(text)
        execution_context = original_request.get("execution_context")
        if not isinstance(execution_context, dict):
            raise ValueError("成语接龙审批缺少执行上下文")
        required_start = execution_context.get("required_start")
        if not isinstance(required_start, str):
            raise ValueError("成语接龙审批缺少确定性开头字")
        state_payload = execution_context.get("chain_state")
        if not isinstance(state_payload, dict):
            raise ValueError("成语接龙审批缺少回合状态")
        state = IdiomRoundState(**state_payload)
        previous_idiom = state.user_idiom if self.position == 1 else state.agent_a_idiom
        if previous_idiom is None:
            raise ValueError("成语接龙审批缺少上一棒")
        validate_chain(idiom, required_start, self.profile.name)
        await self._content_trace(
            executor_id=self.id,
            actor=self.profile.name,
            public_input={
                "previous_idiom": previous_idiom,
                "required_start": required_start,
                "rule": "只输出一个承接上一棒的四字成语",
            },
            public_output=idiom,
        )

        if self.position == 1:
            state = replace(state, agent_a_idiom=idiom)
        else:
            if state.agent_a_idiom is None:
                raise ValueError("成语接龙交接内容缺少Agent甲的成语")
            state = replace(state, agent_b_idiom=idiom)
        await ctx.send_message(state)


class IdiomHandoffExecutor(Executor, IdiomTraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="idiom_handoff")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler
    async def transfer(self, state: IdiomRoundState, ctx: WorkflowContext[IdiomRoundState]) -> None:
        if state.agent_a_idiom is None:
            raise ValueError("成语接龙交接缺少Agent甲结果")
        await self._content_trace(
            executor_id=self.id,
            actor="workflow",
            public_input={"user": state.user_idiom, "agent_a": state.agent_a_idiom},
            public_output={
                "next_actor": "接龙 Agent 乙",
                "required_start": state.agent_a_idiom[-1],
            },
        )
        await ctx.send_message(state)


class IdiomResultExecutor(Executor, IdiomTraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="idiom_result")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler
    async def finalize(
        self,
        state: IdiomRoundState,
        ctx: WorkflowContext[None, str],
    ) -> None:
        if state.agent_a_idiom is None or state.agent_b_idiom is None:
            raise ValueError("成语接龙结果不完整")
        result = (
            "本轮成语接龙\n"
            f"你：{state.user_idiom}\n"
            f"接龙 Agent 甲：{state.agent_a_idiom}\n"
            f"接龙 Agent 乙：{state.agent_b_idiom}\n\n"
            f"轮到你了：请用“{state.agent_b_idiom[-1]}”字开头继续。"
        )
        await self._content_trace(
            executor_id=self.id,
            actor="workflow",
            public_input={
                "user": state.user_idiom,
                "agent_a": state.agent_a_idiom,
                "agent_b": state.agent_b_idiom,
            },
            public_output=result,
            content_type="final_answer",
        )
        await ctx.yield_output(result)


def create_governed_idiom_chain_workflow(
    *,
    thread_id: str,
    run_id: Callable[[], str],
    agent_a: AgentProfileSnapshot,
    agent_b: AgentProfileSnapshot,
    store: InMemoryModelCallReviewStore,
    transport: ProviderTransport,
    sessions: ProductSessionService,
):
    input_executor = IdiomInputExecutor(thread_id=thread_id, sessions=sessions)
    first = IdiomAgentExecutor(
        profile=agent_a,
        position=1,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
    )
    handoff = IdiomHandoffExecutor(thread_id=thread_id, sessions=sessions)
    second = IdiomAgentExecutor(
        profile=agent_b,
        position=2,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
    )
    result = IdiomResultExecutor(thread_id=thread_id, sessions=sessions)
    return (
        WorkflowBuilder(
            name=WORKFLOW_ID,
            start_executor=input_executor,
            output_from=[result],
        )
        .add_edge(input_executor, first)
        .add_edge(first, handoff)
        .add_edge(handoff, second)
        .add_edge(second, result)
        .build()
    )

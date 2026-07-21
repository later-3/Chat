"""MAF-native workflow that pauses before every provider model call."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any, Callable, Protocol

from ag_ui.core import (
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageStartEvent,
)
from agent_framework import Executor, WorkflowBuilder, handler, response_handler
from agent_framework._workflows._request_info_mixin import RequestInfoMixin
from agent_framework_ag_ui import AgentFrameworkWorkflow

from .model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)
from .product_sessions.service import ProductSessionError, ProductSessionService


class ProviderTransport(Protocol):
    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]: ...


def _is_model_call_review_protocol_content(value: dict[str, Any]) -> bool:
    """Exclude MAF review protocol events from the next model context.

    AG-UI projects ``RequestInfoMixin.request_info`` as assistant function-call
    messages.  Those messages are transport/control artifacts containing the
    review card itself, not conversation history or tool evidence intended for
    the model.  Keeping them would recursively embed prior review JSON in the
    next provider request.
    """

    content_type = value.get("type")
    call_id = str(value.get("call_id") or "")
    if content_type == "function_call" and value.get("name") == "request_info":
        return True
    return content_type == "function_result" and call_id.startswith("model_call_approval_")


def normalize_agui_messages_for_provider(message: list[Any]) -> list[dict[str, Any]]:
    """Project user/model conversation content without workflow protocol noise."""

    messages: list[dict[str, Any]] = []
    for item in message:
        role = getattr(item, "role", None)
        contents = getattr(item, "contents", None)
        if not isinstance(role, str) or not isinstance(contents, list):
            continue
        normalized_contents: list[dict[str, Any]] = []
        for content in contents:
            if not hasattr(content, "to_dict"):
                continue
            value = content.to_dict()
            if not isinstance(value, dict):
                continue
            value.pop("additional_properties", None)
            if _is_model_call_review_protocol_content(value):
                continue
            normalized_contents.append(value)
        if normalized_contents:
            messages.append({"role": role, "content": normalized_contents})
    return messages


class ModelCallApprovalExecutor(Executor, RequestInfoMixin):
    """Prepare, review and dispatch one exact provider request."""

    def __init__(
        self,
        *,
        thread_id: str,
        provider_id: str,
        model: str,
        store: InMemoryModelCallReviewStore,
        transport: ProviderTransport,
        run_id: Callable[[], str],
        provider_selection: Callable[[], tuple[str, str]] | None = None,
        sessions: ProductSessionService | None = None,
    ) -> None:
        super().__init__(id="model_call_approval")
        self._thread_id = thread_id
        self._provider_id = provider_id
        self._model = model
        self._store = store
        self._transport = transport
        self._run_id = run_id
        self._provider_selection = provider_selection
        self._sessions = sessions

    @handler(input=list)
    async def prepare(self, message, ctx) -> None:
        if not message:
            raise ValueError("模型调用必须包含至少一条AG-UI消息")
        messages = normalize_agui_messages_for_provider(message)
        if not messages:
            raise ValueError("模型调用没有可发送的用户或模型消息")
        provider_id, model = (
            self._provider_selection()
            if self._provider_selection is not None
            else (self._provider_id, self._model)
        )
        draft = self._store.begin(
            thread_id=self._thread_id,
            run_id=self._run_id(),
            messages=messages,
            model=model,
            provider_id=provider_id,
        )
        if self._sessions is not None:
            await self._sessions.mark_waiting_approval(
                self._thread_id,
                draft_id=draft.draft_id,
                approval_id=draft.approval_id,
            )
        card = draft.review_card()
        await ctx.request_info(card, dict, request_id=draft.approval_id)

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        action = decision.get("decision")
        if action == "revise":
            revised = self._store.successor(
                str(original_request["draft_id"]),
                str(decision["revision_draft_id"]),
            )
            if self._sessions is not None:
                await self._sessions.mark_waiting_approval(
                    self._thread_id,
                    draft_id=revised.draft_id,
                    approval_id=revised.approval_id,
                )
            await ctx.request_info(revised.review_card(), dict, request_id=revised.approval_id)
            return

        approval_id = str(original_request["approval_id"])
        if action == "abandon":
            self._store.abandon(approval_id)
            if self._sessions is not None:
                await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("本次模型调用已放弃，未向模型发送任何内容。")
            return

        if action != "approve":
            raise ValueError(f"不支持的模型调用审批决定: {action}")

        try:
            if self._sessions is not None:
                await self._sessions.mark_running(self._thread_id)
            draft = self._store.claim(
                approval_id=approval_id,
                expected_hash=str(original_request["binding_hash"]),
                owner=f"api-pid-{os.getpid()}",
            )
        except ModelCallDraftConflict:
            await ctx.yield_output("该审批已失效或已被处理，没有重复发送模型请求。")
            return

        emitted = False
        try:
            async for text in self._transport.stream(PreparedProviderRequest.from_draft(draft)):
                emitted = True
                await ctx.yield_output(text)
        except ProviderDispatchError as error:
            # Once dispatch begins, a transport failure is not automatically
            # retried when the provider may already have accepted the body.
            self._store.mark_attempt(
                approval_id,
                error.outcome_status,
                error_code=error.error_code,
            )
            if self._sessions is not None:
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
            if self._sessions is not None:
                await self._sessions.fail_active_run(
                    self._thread_id,
                    status="outcome_unknown",
                    error_code="provider_dispatch_cancelled",
                    message="Provider发送期间被取消，结果未知。",
                )
            raise
        self._store.mark_attempt(approval_id, "completed")
        if not emitted:
            await ctx.yield_output("模型调用已完成，但没有返回可显示的文本。")


def create_model_call_workflow(
    *,
    provider_id: str,
    model: str,
    store: InMemoryModelCallReviewStore,
    transport: ProviderTransport,
    sessions: ProductSessionService | None = None,
) -> AgentFrameworkWorkflow:
    """Create one thread-scoped MAF Workflow graph for model-call review."""

    run_ids: dict[str, str] = {}
    selections: dict[str, tuple[str, str]] = {}

    def workflow_factory(thread_id: str):
        executor = ModelCallApprovalExecutor(
            thread_id=thread_id,
            provider_id=provider_id,
            model=model,
            store=store,
            transport=transport,
            run_id=lambda: run_ids.get(thread_id, f"run_{uuid.uuid4().hex}"),
            provider_selection=lambda: selections.get(thread_id, (provider_id, model)),
            sessions=sessions,
        )
        return WorkflowBuilder(
            name="chat-model-call-approval",
            start_executor=executor,
            output_from=[executor],
        ).build()

    class RunTrackingWorkflow(AgentFrameworkWorkflow):
        async def run(self, input_data: dict[str, Any]):
            thread_id = self._thread_id_from_input(input_data)
            agui_run_id = str(input_data.get("run_id") or input_data.get("runId") or f"run_{uuid.uuid4().hex}")
            run_ids[thread_id] = agui_run_id
            if sessions is not None:
                try:
                    accepted = await sessions.prepare_agui_run(input_data)
                except ProductSessionError as error:
                    yield RunStartedEvent(run_id=agui_run_id, thread_id=thread_id)
                    yield RunErrorEvent(message=str(error), code=error.code)
                    return
                selections[thread_id] = (
                    accepted.provider_id or provider_id,
                    accepted.model or model,
                )
            terminal_event: RunFinishedEvent | RunErrorEvent | None = None
            assistant_message_id: str | None = None
            assistant_text: list[str] = []
            try:
                async for event in super().run(input_data):
                    # agent-framework-ag-ui 1.0.0rc8 can emit RUN_FINISHED from a
                    # workflow terminal-status event before draining an open text
                    # message. AG-UI clients reject that ordering, so hold the one
                    # terminal event until every message-end event has passed.
                    if isinstance(event, (RunFinishedEvent, RunErrorEvent)):
                        # Prefer an error over a later success-like terminal event.
                        if terminal_event is None or isinstance(event, RunErrorEvent):
                            terminal_event = event
                        continue
                    if isinstance(event, TextMessageStartEvent) and event.role == "assistant":
                        assistant_message_id = event.message_id
                    elif isinstance(event, TextMessageContentEvent):
                        assistant_text.append(event.delta)
                    yield event
            except Exception:
                if sessions is not None:
                    await sessions.fail_active_run(
                        thread_id,
                        error_code="workflow_runtime_error",
                        message="MAF Workflow运行异常结束。",
                    )
                yield RunErrorEvent(
                    message="MAF Workflow运行异常结束。",
                    code="WORKFLOW_RUNTIME_ERROR",
                )
                return
            if terminal_event is not None:
                if sessions is not None:
                    if isinstance(terminal_event, RunErrorEvent):
                        await sessions.fail_active_run(
                            thread_id,
                            error_code=getattr(terminal_event, "code", None),
                            message=terminal_event.message,
                        )
                    else:
                        outcome = getattr(terminal_event, "outcome", None)
                        if getattr(outcome, "type", None) == "interrupt":
                            await sessions.mark_waiting_approval(thread_id)
                        else:
                            active_run = await sessions.active_run(thread_id)
                            if active_run is None:
                                recent_runs = await sessions.list_runs(thread_id)
                                if recent_runs and recent_runs[0]["status"] == "abandoned":
                                    yield terminal_event
                                    return
                            try:
                                committed = await sessions.complete_active_run(
                                    thread_id,
                                    assistant_text="".join(assistant_text),
                                    agui_message_id=assistant_message_id,
                                )
                                if committed is None:
                                    raise RuntimeError("Product Store没有可提交的活动Run")
                            except Exception:
                                await sessions.fail_active_run(
                                    thread_id,
                                    error_code="product_commit_failed",
                                    message="模型输出已产生，但Product Store终态提交失败。",
                                )
                                yield RunErrorEvent(
                                    message="模型输出已产生，但Product Store终态提交失败。",
                                    code="PRODUCT_COMMIT_FAILED",
                                )
                                return
                yield terminal_event

    return RunTrackingWorkflow(
        workflow_factory=workflow_factory,
        name="Chat model-call approval",
        description="Pauses before each exact provider request until the user approves it.",
    )

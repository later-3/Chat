"""MAF-native workflow that pauses before every provider model call."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any, Callable, Protocol

from ag_ui.core import RunErrorEvent, RunFinishedEvent
from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler, response_handler
from agent_framework._workflows._request_info_mixin import RequestInfoMixin
from agent_framework_ag_ui import AgentFrameworkWorkflow

from .model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)


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
    ) -> None:
        super().__init__(id="model_call_approval")
        self._thread_id = thread_id
        self._provider_id = provider_id
        self._model = model
        self._store = store
        self._transport = transport
        self._run_id = run_id

    @handler(input=list)
    async def prepare(self, message, ctx) -> None:
        if not message:
            raise ValueError("模型调用必须包含至少一条AG-UI消息")
        messages = normalize_agui_messages_for_provider(message)
        if not messages:
            raise ValueError("模型调用没有可发送的用户或模型消息")
        draft = self._store.begin(
            thread_id=self._thread_id,
            run_id=self._run_id(),
            messages=messages,
            model=self._model,
            provider_id=self._provider_id,
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
            await ctx.request_info(revised.review_card(), dict, request_id=revised.approval_id)
            return

        approval_id = str(original_request["approval_id"])
        if action == "abandon":
            self._store.abandon(approval_id)
            await ctx.yield_output("本次模型调用已放弃，未向模型发送任何内容。")
            return

        if action != "approve":
            raise ValueError(f"不支持的模型调用审批决定: {action}")

        try:
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
            raise
        except asyncio.CancelledError:
            self._store.mark_attempt(
                approval_id,
                "outcome_unknown",
                error_code="provider_dispatch_cancelled",
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
) -> AgentFrameworkWorkflow:
    """Create one thread-scoped MAF Workflow graph for model-call review."""

    run_ids: dict[str, str] = {}

    def workflow_factory(thread_id: str):
        executor = ModelCallApprovalExecutor(
            thread_id=thread_id,
            provider_id=provider_id,
            model=model,
            store=store,
            transport=transport,
            run_id=lambda: run_ids.get(thread_id, f"run_{uuid.uuid4().hex}"),
        )
        return WorkflowBuilder(
            name="chat-model-call-approval",
            start_executor=executor,
            output_from=[executor],
        ).build()

    class RunTrackingWorkflow(AgentFrameworkWorkflow):
        async def run(self, input_data: dict[str, Any]):
            thread_id = self._thread_id_from_input(input_data)
            run_ids[thread_id] = str(input_data.get("run_id") or input_data.get("runId") or f"run_{uuid.uuid4().hex}")
            terminal_event: RunFinishedEvent | RunErrorEvent | None = None
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
                yield event
            if terminal_event is not None:
                yield terminal_event

    return RunTrackingWorkflow(
        workflow_factory=workflow_factory,
        name="Chat model-call approval",
        description="Pauses before each exact provider request until the user approves it.",
    )

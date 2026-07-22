"""MAF-native workflow that pauses before every provider model call."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any, Callable, Protocol

from ag_ui.core import (
    CustomEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageStartEvent,
)
from agent_framework import Executor, WorkflowBuilder, WorkflowEvent, handler, response_handler
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
        product_run_id: Callable[[], str | None] | None = None,
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
        self._product_run_id = product_run_id
        self._provider_selection = provider_selection
        self._sessions = sessions

    async def _stage(
        self,
        ctx: Any,
        stage_id: str,
        status: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        payload = {
            "workflow_id": "chat-model-call-approval",
            "stage_id": stage_id,
            "status": status,
            "executor_id": self.id,
            "details": details or {},
        }
        product_run_id = self._product_run_id() if self._product_run_id is not None else None
        if self._sessions is not None and product_run_id is not None:
            await self._sessions.record_trace(
                self._thread_id,
                product_run_id,
                "workflow.stage",
                payload,
            )
        add_event = getattr(ctx, "add_event", None)
        if add_event is not None:
            await add_event(WorkflowEvent("workflow_stage", data=payload, executor_id=self.id))

    @handler(input=list)
    async def prepare(self, message, ctx) -> None:
        await self._stage(
            ctx,
            "request.compile",
            "in_progress",
            {"code": "ModelCallApprovalExecutor.prepare"},
        )
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
        await self._stage(
            ctx,
            "request.compile",
            "completed",
            {
                "draft_id": draft.draft_id,
                "version": draft.version,
                "body_sha256": draft.body_sha256,
            },
        )
        if self._sessions is not None:
            await self._sessions.mark_waiting_approval(
                self._thread_id,
                draft_id=draft.draft_id,
                approval_id=draft.approval_id,
            )
        card = draft.review_card()
        await self._stage(
            ctx,
            "approval.wait",
            "waiting_approval",
            {"approval_id": draft.approval_id, "draft_id": draft.draft_id},
        )
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
            await self._stage(
                ctx,
                "request.compile",
                "completed",
                {
                    "draft_id": revised.draft_id,
                    "version": revised.version,
                    "body_sha256": revised.body_sha256,
                    "revision": True,
                },
            )
            await self._stage(
                ctx,
                "approval.wait",
                "waiting_approval",
                {"approval_id": revised.approval_id, "draft_id": revised.draft_id},
            )
            await ctx.request_info(revised.review_card(), dict, request_id=revised.approval_id)
            return

        approval_id = str(original_request["approval_id"])
        if action == "abandon":
            await self._stage(ctx, "approval.wait", "abandoned")
            for stage_id in (
                "approval.claim",
                "provider.dispatch",
                "provider.receive",
                "provider.decode",
                "agui.project",
                "product.commit",
            ):
                await self._stage(ctx, stage_id, "skipped", {"reason": "user_abandoned"})
            self._store.abandon(approval_id)
            if self._sessions is not None:
                await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("本次模型调用已放弃，未向模型发送任何内容。")
            return

        if action != "approve":
            raise ValueError(f"不支持的模型调用审批决定: {action}")

        try:
            await self._stage(ctx, "approval.wait", "completed")
            await self._stage(ctx, "approval.claim", "in_progress")
            if self._sessions is not None:
                await self._sessions.mark_running(self._thread_id)
            draft = self._store.claim(
                approval_id=approval_id,
                expected_hash=str(original_request["binding_hash"]),
                owner=f"api-pid-{os.getpid()}",
            )
            await self._stage(
                ctx,
                "approval.claim",
                "completed",
                {"draft_id": draft.draft_id, "body_sha256": draft.body_sha256},
            )
        except ModelCallDraftConflict:
            await self._stage(ctx, "approval.claim", "failed", {"reason": "stale_or_claimed"})
            await ctx.yield_output("该审批已失效或已被处理，没有重复发送模型请求。")
            return

        emitted = False
        active_provider_stage = "provider.dispatch"
        reported_provider_stages: set[str] = set()

        async def report_provider_stage(
            stage_id: str,
            status: str,
            details: dict[str, Any],
        ) -> None:
            nonlocal active_provider_stage
            reported_provider_stages.add(stage_id)
            if status == "in_progress":
                active_provider_stage = stage_id
            await self._stage(ctx, stage_id, status, details)

        try:
            await self._stage(ctx, "provider.dispatch", "in_progress")
            prepared = PreparedProviderRequest.from_draft(
                draft,
                stage_reporter=report_provider_stage,
            )
            async for text in self._transport.stream(prepared):
                if not emitted:
                    # Test transports and future adapters may not expose the fine-grained
                    # reporter yet. The first parsed text is still a real lower bound for
                    # dispatch, receive and decode completion.
                    for stage_id in ("provider.dispatch", "provider.receive", "provider.decode"):
                        if stage_id not in reported_provider_stages:
                            await self._stage(ctx, stage_id, "completed")
                    await self._stage(ctx, "agui.project", "in_progress")
                emitted = True
                await ctx.yield_output(text)
            if not emitted:
                for stage_id in ("provider.dispatch", "provider.receive", "provider.decode"):
                    if stage_id not in reported_provider_stages:
                        await self._stage(ctx, stage_id, "completed", {"empty": True})
                await self._stage(ctx, "agui.project", "in_progress", {"empty": True})
            await self._stage(ctx, "agui.project", "completed")
        except ProviderDispatchError as error:
            await self._stage(
                ctx,
                active_provider_stage,
                "failed",
                {"error_code": error.error_code, "outcome_status": error.outcome_status},
            )
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
            await self._stage(
                ctx,
                active_provider_stage,
                "failed",
                {"error_code": "provider_dispatch_cancelled", "outcome_status": "outcome_unknown"},
            )
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
    product_run_ids: dict[str, str] = {}
    selections: dict[str, tuple[str, str]] = {}

    def workflow_factory(thread_id: str):
        executor = ModelCallApprovalExecutor(
            thread_id=thread_id,
            provider_id=provider_id,
            model=model,
            store=store,
            transport=transport,
            run_id=lambda: run_ids.get(thread_id, f"run_{uuid.uuid4().hex}"),
            product_run_id=lambda: product_run_ids.get(thread_id),
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
                product_run_ids[thread_id] = accepted.product_run_id
                for stage_id, details in (
                    (
                        "agui.ingress",
                        {
                            "agui_run_id": agui_run_id,
                            "resume": accepted.is_resume,
                            "code": "RunTrackingWorkflow.run",
                        },
                    ),
                    (
                        "product.prepare",
                        {
                            "product_run_id": accepted.product_run_id,
                            "resume": accepted.is_resume,
                            "code": "ProductSessionService.prepare_agui_run",
                        },
                    ),
                    (
                        "maf.enter",
                        {
                            "executor_id": "model_call_approval",
                            "code": "AgentFrameworkWorkflow.run",
                        },
                    ),
                ):
                    await sessions.record_trace(
                        thread_id,
                        accepted.product_run_id,
                        "workflow.stage",
                        {
                            "workflow_id": "chat-model-call-approval",
                            "stage_id": stage_id,
                            "status": "in_progress" if stage_id == "maf.enter" else "completed",
                            "details": details,
                        },
                    )
            prelude_sent = False

            async def record_outer_stage(
                run_id: str,
                stage_id: str,
                status: str,
                details: dict[str, Any] | None = None,
            ) -> None:
                if sessions is None:
                    return
                await sessions.record_trace(
                    thread_id,
                    run_id,
                    "workflow.stage",
                    {
                        "workflow_id": "chat-model-call-approval",
                        "stage_id": stage_id,
                        "status": status,
                        "details": details or {},
                    },
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
                    if isinstance(event, RunStartedEvent) and not prelude_sent:
                        yield event
                        prelude_sent = True
                        for stage_id, status in (
                            ("agui.ingress", "completed"),
                            ("product.prepare", "completed"),
                            ("maf.enter", "in_progress"),
                        ):
                            yield CustomEvent(
                                name="workflow_stage",
                                value={
                                    "workflow_id": "chat-model-call-approval",
                                    "stage_id": stage_id,
                                    "status": status,
                                    "details": {},
                                },
                            )
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
                        failed_run = await sessions.active_run(thread_id)
                        await sessions.fail_active_run(
                            thread_id,
                            error_code=getattr(terminal_event, "code", None),
                            message=terminal_event.message,
                        )
                        if failed_run is not None:
                            await record_outer_stage(
                                failed_run["id"],
                                "maf.enter",
                                "failed",
                                {"error_code": getattr(terminal_event, "code", None)},
                            )
                            await record_outer_stage(
                                failed_run["id"],
                                "product.commit",
                                "skipped",
                                {"reason": "workflow_failed"},
                            )
                            await record_outer_stage(failed_run["id"], "agui.terminal", "completed")
                    else:
                        outcome = getattr(terminal_event, "outcome", None)
                        if getattr(outcome, "type", None) == "interrupt":
                            waiting_run = await sessions.active_run(thread_id)
                            await sessions.mark_waiting_approval(thread_id)
                            if waiting_run is not None:
                                await record_outer_stage(
                                    waiting_run["id"],
                                    "agui.terminal",
                                    "completed",
                                    {"outcome": "interrupt"},
                                )
                        else:
                            active_run = await sessions.active_run(thread_id)
                            if active_run is None:
                                recent_runs = await sessions.list_runs(thread_id)
                                if recent_runs and recent_runs[0]["status"] == "abandoned":
                                    await record_outer_stage(
                                        recent_runs[0]["id"],
                                        "maf.enter",
                                        "completed",
                                        {"outcome": "abandoned"},
                                    )
                                    await record_outer_stage(
                                        recent_runs[0]["id"],
                                        "agui.terminal",
                                        "completed",
                                        {"outcome": "abandoned"},
                                    )
                                    yield terminal_event
                                    return
                            try:
                                active_before_commit = await sessions.active_run(thread_id)
                                if active_before_commit is not None:
                                    await record_outer_stage(
                                        active_before_commit["id"],
                                        "product.commit",
                                        "in_progress",
                                        {
                                            "code": "ProductSessionService.complete_active_run"
                                        },
                                    )
                                    yield CustomEvent(
                                        name="workflow_stage",
                                        value={
                                            "workflow_id": "chat-model-call-approval",
                                            "stage_id": "product.commit",
                                            "status": "in_progress",
                                            "details": {},
                                        },
                                    )
                                committed = await sessions.complete_active_run(
                                    thread_id,
                                    assistant_text="".join(assistant_text),
                                    agui_message_id=assistant_message_id,
                                )
                                if committed is None:
                                    raise RuntimeError("Product Store没有可提交的活动Run")
                                if active_before_commit is not None:
                                    await record_outer_stage(
                                        active_before_commit["id"],
                                        "product.commit",
                                        "completed",
                                        {"assistant_message_id": committed["id"]},
                                    )
                                    await record_outer_stage(
                                        active_before_commit["id"],
                                        "maf.enter",
                                        "completed",
                                    )
                                    await record_outer_stage(
                                        active_before_commit["id"],
                                        "agui.terminal",
                                        "completed",
                                    )
                                    yield CustomEvent(
                                        name="workflow_stage",
                                        value={
                                            "workflow_id": "chat-model-call-approval",
                                            "stage_id": "product.commit",
                                            "status": "completed",
                                            "details": {},
                                        },
                                    )
                            except Exception:
                                commit_run_id = (
                                    active_before_commit["id"]
                                    if active_before_commit is not None
                                    else product_run_ids.get(thread_id)
                                )
                                await sessions.fail_active_run(
                                    thread_id,
                                    error_code="product_commit_failed",
                                    message="模型输出已产生，但Product Store终态提交失败。",
                                )
                                if commit_run_id is not None:
                                    await record_outer_stage(
                                        commit_run_id,
                                        "product.commit",
                                        "failed",
                                        {"error_code": "product_commit_failed"},
                                    )
                                    await record_outer_stage(
                                        commit_run_id,
                                        "maf.enter",
                                        "failed",
                                        {"error_code": "product_commit_failed"},
                                    )
                                    await record_outer_stage(
                                        commit_run_id,
                                        "agui.terminal",
                                        "completed",
                                        {"outcome": "error"},
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

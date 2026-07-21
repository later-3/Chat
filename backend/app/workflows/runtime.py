"""Product finalization gate for MAF Workflows exposed over AG-UI."""

from __future__ import annotations

from typing import Any

from ag_ui.core import (
    ActivitySnapshotEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageStartEvent,
)
from agent_framework_ag_ui import AgentFrameworkWorkflow

from ..product_sessions.service import ProductSessionError, ProductSessionService
from .catalog import WorkflowDefinition


class ProductAwareWorkflow(AgentFrameworkWorkflow):
    """Persist Workflow progress while MAF remains the runtime authority."""

    def __init__(
        self,
        *,
        workflow_factory,
        sessions: ProductSessionService,
        definition: WorkflowDefinition,
    ) -> None:
        super().__init__(
            workflow_factory=workflow_factory,
            name=definition.name,
            description=definition.description,
        )
        self._sessions = sessions
        self.definition = definition

    async def run(self, input_data: dict[str, Any]):
        thread_id = self._thread_id_from_input(input_data)
        agui_run_id = str(input_data.get("run_id") or input_data.get("runId") or "")
        try:
            accepted = await self._sessions.prepare_agui_run(input_data)
            await self._sessions.mark_running(thread_id)
            await self._sessions.record_trace(
                thread_id,
                accepted.product_run_id,
                "workflow.started",
                {"workflow_id": self.definition.id, "version": self.definition.version},
            )
        except ProductSessionError as error:
            yield RunStartedEvent(run_id=agui_run_id, thread_id=thread_id)
            yield RunErrorEvent(message=str(error), code=error.code)
            return

        assistant_message_id: str | None = None
        assistant_text: list[str] = []
        terminal: RunFinishedEvent | RunErrorEvent | None = None
        try:
            async for event in super().run(input_data):
                if isinstance(event, TextMessageStartEvent) and event.role == "assistant":
                    assistant_message_id = event.message_id
                elif isinstance(event, TextMessageContentEvent):
                    assistant_text.append(event.delta)
                elif isinstance(event, ActivitySnapshotEvent) and event.activity_type == "executor":
                    content = event.content if isinstance(event.content, dict) else {"value": event.content}
                    trace_payload = {
                        "workflow_id": self.definition.id,
                        "executor_id": content.get("executor_id"),
                        "status": content.get("status"),
                    }
                    details = content.get("details")
                    if isinstance(details, dict):
                        trace_payload["details"] = {
                            key: details.get(key)
                            for key in ("error_type", "message", "executor_id")
                            if details.get(key) is not None
                        }
                    await self._sessions.record_trace(
                        thread_id,
                        accepted.product_run_id,
                        "workflow.node",
                        trace_payload,
                    )
                    event = ActivitySnapshotEvent(
                        messageId=event.message_id,
                        activityType="executor",
                        content={
                            key: value
                            for key, value in trace_payload.items()
                            if key != "workflow_id"
                        },
                    )
                if isinstance(event, (RunFinishedEvent, RunErrorEvent)):
                    if terminal is None or isinstance(event, RunErrorEvent):
                        terminal = event
                    continue
                yield event
        except Exception as error:
            await self._sessions.fail_active_run(
                thread_id,
                error_code="workflow_runtime_error",
                message=str(error) or "MAF Workflow运行异常结束。",
            )
            yield RunErrorEvent(
                message=str(error) or "MAF Workflow运行异常结束。",
                code="WORKFLOW_RUNTIME_ERROR",
            )
            return

        if isinstance(terminal, RunErrorEvent):
            await self._sessions.fail_active_run(
                thread_id,
                error_code=getattr(terminal, "code", None),
                message=terminal.message,
            )
            yield terminal
            return
        if terminal is None:
            await self._sessions.fail_active_run(
                thread_id,
                status="interrupted",
                error_code="missing_terminal_event",
                message="MAF Workflow没有产生终态事件。",
            )
            yield RunErrorEvent(
                message="MAF Workflow没有产生终态事件。",
                code="MISSING_TERMINAL_EVENT",
            )
            return

        try:
            committed = await self._sessions.complete_active_run(
                thread_id,
                assistant_text="".join(assistant_text),
                agui_message_id=assistant_message_id,
            )
            if committed is None:
                raise RuntimeError("Product Store没有可提交的活动Run")
        except Exception:
            await self._sessions.fail_active_run(
                thread_id,
                error_code="product_commit_failed",
                message="Workflow输出已产生，但Product Store终态提交失败。",
            )
            yield RunErrorEvent(
                message="Workflow输出已产生，但Product Store终态提交失败。",
                code="PRODUCT_COMMIT_FAILED",
            )
            return
        yield terminal

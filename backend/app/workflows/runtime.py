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
        run_ids: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            workflow_factory=workflow_factory,
            name=definition.name,
            description=definition.description,
        )
        self._sessions = sessions
        self.definition = definition
        self._run_ids = run_ids
        self._waiting_nodes: dict[str, str] = {}

    async def run(self, input_data: dict[str, Any]):
        thread_id = self._thread_id_from_input(input_data)
        agui_run_id = str(input_data.get("run_id") or input_data.get("runId") or "")
        resumed_activity: ActivitySnapshotEvent | None = None
        try:
            accepted = await self._sessions.prepare_agui_run(input_data)
            if self._run_ids is not None:
                # Runtime factories that persist governance facts need the
                # authoritative Product Run id.  The AG-UI run id remains a
                # correlation value on the Product Run, but is not a database
                # foreign key or authorization identity.
                self._run_ids[thread_id] = accepted.product_run_id
            await self._sessions.mark_running(thread_id)
            await self._sessions.record_trace(
                thread_id,
                accepted.product_run_id,
                "workflow.resumed" if accepted.is_resume else "workflow.started",
                {"workflow_id": self.definition.id, "version": self.definition.version},
            )
            resumed_node = self._waiting_nodes.pop(thread_id, None) if accepted.is_resume else None
            if resumed_node is not None:
                resumed_payload = {
                    "workflow_id": self.definition.id,
                    "executor_id": resumed_node,
                    "status": "completed",
                    "details": {"message": "审批决定已提交，Workflow继续推进。"},
                }
                await self._sessions.record_trace(
                    thread_id,
                    accepted.product_run_id,
                    "workflow.node",
                    resumed_payload,
                )
                resumed_activity = ActivitySnapshotEvent(
                    messageId=f"workflow-resumed-{resumed_node}",
                    activityType="executor",
                    content={
                        key: value
                        for key, value in resumed_payload.items()
                        if key != "workflow_id"
                    },
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
                if isinstance(event, RunStartedEvent):
                    # AG-UI requires RUN_STARTED to be the first event of every
                    # HTTP run, including resume requests. Product projection
                    # events therefore follow (never precede) the MAF prelude.
                    yield event
                    if resumed_activity is not None:
                        yield resumed_activity
                        resumed_activity = None
                    continue
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
            self._waiting_nodes.pop(thread_id, None)
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

        outcome = getattr(terminal, "outcome", None)
        if getattr(outcome, "type", None) == "interrupt":
            waiting_executor_id: str | None = None
            for interrupt in getattr(outcome, "interrupts", ()) or ():
                metadata = getattr(interrupt, "metadata", None)
                if not isinstance(metadata, dict):
                    continue
                framework = metadata.get("agent_framework")
                data = framework.get("data") if isinstance(framework, dict) else None
                execution = data.get("execution_context") if isinstance(data, dict) else None
                if isinstance(execution, dict):
                    waiting_executor_id = next(
                        (
                            execution[key]
                            for key in ("executor_id", "agent_id", "tool_id")
                            if isinstance(execution.get(key), str)
                        ),
                        None,
                    )
                    break
            if waiting_executor_id is not None:
                self._waiting_nodes[thread_id] = waiting_executor_id
                waiting_payload = {
                    "workflow_id": self.definition.id,
                    "executor_id": waiting_executor_id,
                    "status": "in_progress",
                    "details": {
                        "message": (
                            "请求已准备，等待用户审批后才会继续。"
                        ),
                        "wait_reason": "governed_approval",
                    },
                }
                await self._sessions.record_trace(
                    thread_id,
                    accepted.product_run_id,
                    "workflow.node",
                    waiting_payload,
                )
                yield ActivitySnapshotEvent(
                    messageId=f"workflow-waiting-{waiting_executor_id}",
                    activityType="executor",
                    content={key: value for key, value in waiting_payload.items() if key != "workflow_id"},
                )
            await self._sessions.mark_waiting_approval(thread_id)
            yield terminal
            return

        active_run = await self._sessions.active_run(thread_id)
        if active_run is None:
            recent_runs = await self._sessions.list_runs(thread_id)
            if recent_runs and recent_runs[0]["status"] == "abandoned":
                yield terminal
                return

        try:
            self._waiting_nodes.pop(thread_id, None)
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

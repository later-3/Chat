"""AG-UI与MAF Workflow之间的Product Run生命周期和最终提交门。

Execution Worker调用这里，不是HTTP请求直接执行。它准备/恢复Product Run与Attempt，
将MAF节点活动投影为Product Trace，处理中断与Checkpoint，成功时提交Assistant Message，
失败时关闭Run。Product DB是权威事实源，MAF仍拥有图与运行时状态。
"""

from __future__ import annotations

import logging
from typing import Any

from ag_ui.core import (
    ActivitySnapshotEvent,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageStartEvent,
)
from agent_framework import WorkflowCheckpointException
from agent_framework_ag_ui import AgentFrameworkWorkflow

from ..governance.service import (
    ExecutionGovernanceService,
    GovernanceConflict,
    GovernanceValidationError,
)
from ..product_sessions.service import ProductSessionError, ProductSessionService
from ..runtime_adapters import pending_request_ids, restore_workflow_checkpoint
from .catalog import WorkflowDefinition
from .checkpoints import CheckpointStorageFactory

logger = logging.getLogger(__name__)


def _resume_interrupt_id(input_data: dict[str, Any]) -> str | None:
    """从AG-UI resume载荷中提取interruptId；兼容单对象/列表与camel/snake键名，取不到返回None。"""
    resume = input_data.get("resume")
    entries = resume if isinstance(resume, list) else [resume] if isinstance(resume, dict) else []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        value = entry.get("interruptId", entry.get("interrupt_id", entry.get("id")))
        if isinstance(value, str) and value:
            return value
    return None


def _interrupt_contract(interrupt: Any) -> dict[str, str] | None:
    """把MAF interrupt对象投影为前端审批合同字段（request/decision/executor ID）。

    从``metadata.agent_framework``逐层取数，缺少关键ID时返回None，由调用方降级处理；
    该投影是HITL审批卡与持久Decision之间唯一的ID桥。
    """
    metadata = getattr(interrupt, "metadata", None)
    if not isinstance(metadata, dict):
        return None
    framework = metadata.get("agent_framework")
    if not isinstance(framework, dict):
        return None
    data = framework.get("data")
    if not isinstance(data, dict):
        return None
    execution = data.get("execution_context")
    execution = execution if isinstance(execution, dict) else {}
    governance = execution.get("governance")
    governance = governance if isinstance(governance, dict) else {}
    maf_request_id = str(framework.get("request_id") or getattr(interrupt, "id", "") or "")
    decision_request_id = str(
        data.get("decision_request_id") or governance.get("decision_request_id") or maf_request_id
    )
    executor_id = str(
        execution.get("executor_id")
        or execution.get("agent_id")
        or framework.get("source_executor_id")
        or "unknown"
    )
    if not maf_request_id or not decision_request_id:
        return None
    return {
        "maf_request_id": maf_request_id,
        "decision_request_id": decision_request_id,
        "executor_id": executor_id,
        "agui_interrupt_id": str(getattr(interrupt, "id", "") or maf_request_id),
    }


class ProductAwareWorkflow(AgentFrameworkWorkflow):
    """持久化Workflow的产品侧进度，同时保留MAF为运行时权威。

    它拥有一轮Product侧生命周期：准备Run/Attempt、恢复MAF Checkpoint、记录节点Trace、
    执行提交/失败门。MAF拥有图执行、事件转换和Checkpoint；AG-UI ``runId``只用于关联，
    不能作为数据库主键或授权身份。
    """

    def __init__(
        self,
        *,
        workflow_factory,
        sessions: ProductSessionService,
        definition: WorkflowDefinition,
        run_ids: dict[str, str] | None = None,
        governance: ExecutionGovernanceService | None = None,
        checkpoint_storage_factory: CheckpointStorageFactory | None = None,
    ) -> None:
        """注入Product会话服务与Workflow定义；``run_ids``用于恢复路径绑定既有Run。"""

        super().__init__(
            workflow_factory=workflow_factory,
            name=definition.name,
            description=definition.description,
        )
        self._sessions = sessions
        self.definition = definition
        self._run_ids = run_ids
        self._governance = governance
        self._checkpoint_storage_factory = checkpoint_storage_factory
        self._waiting_nodes: dict[str, str] = {}

    # BP-07 触发：MAF Workflow执行入口。Worker按endpoint_key从Registry取到Runner后调用。
    # 用Product Run生命周期包住MAF执行流程。
    # 跨边界：Worker->MAF节点边界。
    # 对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#8
    async def run(self, input_data: dict[str, Any]):
        """驱动一轮AG-UI Run，并把MAF事件投影为Product事实。

        MAF Workflow执行入口。Worker按endpoint_key从Registry取到Runner后调用。
        用Product Run生命周期包住MAF执行流程。

        ``run()``内部步骤R1准备/恢复Product Run与Checkpoint；R2流式处理MAF事件、节点Trace
        和候选文本；R3处理中断/失败/成功终态。这里的R1-R3不是主Workflow学习阶段S1-S7。
        成功提交Message时，ProductSessionService在同一事务
        物化机器版和人读版双Trace；等待审批时Run保持活动且不提前生成终态报告。

        跨边界：Worker->MAF节点边界。
        对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#8
        """
        # DEBUG-BREAKPOINT-NOTE: BP-07
        # DEBUG-BREAKPOINT-NOTE: 触发: MAF Workflow执行入口。
        # DEBUG-BREAKPOINT-NOTE: 触发: Worker按endpoint_key从Registry取到Runner后调用此方法。
        # DEBUG-BREAKPOINT-NOTE: 触发: 它用Product Run生命周期包住MAF执行流程，开始时调用BP-04幂等复核，结束时调用BP-06完成门。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：从断点停住到知道来路和下一跳#8（Worker->MAF节点边界）。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个Run触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-07
        thread_id = self._thread_id_from_input(input_data)
        agui_run_id = str(input_data.get("run_id") or input_data.get("runId") or "")
        resumed_activity: ActivitySnapshotEvent | None = None
        resuming_link_id: str | None = None
        try:
            accepted = await self._sessions.prepare_agui_run(input_data)
            if self._run_ids is not None:
                # Runtime factories that persist governance facts need the
                # authoritative Product Run id.  The AG-UI run id remains a
                # correlation value on the Product Run, but is not a database
                # foreign key or authorization identity.
                self._run_ids[thread_id] = accepted.product_run_id
            if not accepted.is_resume:
                # MAF's AG-UI adapter intentionally caches one Workflow instance
                # per thread/snapshot scope.  Our checkpoint adapter is instead
                # bound to one immutable Product Run.  Reusing a completed
                # turn's Workflow would therefore persist the next turn's
                # checkpoint under the previous Product Run.  A fresh Product
                # Run must get a fresh runtime graph; resume requests keep (or
                # restore) the graph that owns their checkpoint.
                self.clear_thread_workflow(thread_id)
            if accepted.is_resume and self._checkpoint_storage_factory is not None:
                if self._governance is None:
                    raise ProductSessionError("Checkpoint恢复缺少Execution Governance接合层")
                maf_request_id = _resume_interrupt_id(input_data)
                if maf_request_id is None:
                    raise ProductSessionError("AG-UI Resume缺少interruptId")
                link = await self._governance.runtime_interrupt_for_maf_request(
                    maf_request_id=maf_request_id,
                    product_run_id=accepted.product_run_id,
                )
                resuming_link_id = link.id
                workflow = self._resolve_workflow(thread_id)
                if workflow.graph_signature_hash != link.maf_graph_signature_hash:
                    await self._governance.mark_runtime_interrupt(
                        link_id=link.id,
                        status="recovery_required",
                        error_code="workflow_graph_changed",
                    )
                    raise ProductSessionError("Workflow图版本已变化，不能用旧Checkpoint静默恢复")
                pending = await pending_request_ids(workflow)
                if maf_request_id not in pending:
                    storage = self._checkpoint_storage_factory(accepted.product_run_id)
                    # MAF core exposes checkpoint restore through Workflow.run;
                    # AG-UI rc8 does not forward checkpoint_id.  This isolated
                    # bridge restores only the runner state, after which the
                    # standard AG-UI converter validates and applies Resume.
                    await restore_workflow_checkpoint(
                        workflow,
                        checkpoint_id=link.maf_checkpoint_id,
                        checkpoint_storage=storage,
                    )
                    logger.info(
                        "workflow_checkpoint_restored run_id=%s checkpoint_id=%s maf_request_id=%s",
                        accepted.product_run_id,
                        link.maf_checkpoint_id,
                        maf_request_id,
                    )
                await self._governance.mark_runtime_interrupt(
                    link_id=link.id,
                    status="resuming",
                )
                self._waiting_nodes[thread_id] = link.maf_executor_id
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
                    message_id=f"workflow-resumed-{resumed_node}",
                    activity_type="executor",
                    content={key: value for key, value in resumed_payload.items() if key != "workflow_id"},
                )
        except (
            ProductSessionError,
            GovernanceConflict,
            GovernanceValidationError,
            WorkflowCheckpointException,
        ) as error:
            if resuming_link_id is not None and self._governance is not None:
                try:
                    await self._governance.mark_runtime_interrupt(
                        link_id=resuming_link_id,
                        status="recovery_required",
                        error_code=getattr(error, "code", None) or "checkpoint_restore_failed",
                    )
                except Exception:
                    logger.exception(
                        "runtime_interrupt_recovery_projection_failed link_id=%s",
                        resuming_link_id,
                    )
            if resuming_link_id is not None:
                try:
                    await self._sessions.fail_active_run(
                        thread_id,
                        status="interrupted",
                        error_code=getattr(error, "code", None) or "checkpoint_restore_failed",
                        message=str(error),
                    )
                except Exception:
                    logger.exception("product_run_recovery_projection_failed thread_id=%s", thread_id)
            yield RunStartedEvent(run_id=agui_run_id, thread_id=thread_id)
            yield RunErrorEvent(
                message=str(error),
                code=getattr(error, "code", "WORKFLOW_CHECKPOINT_RESTORE_FAILED"),
            )
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
                        message_id=event.message_id,
                        activity_type="executor",
                        content={key: value for key, value in trace_payload.items() if key != "workflow_id"},
                    )
                if isinstance(event, (RunFinishedEvent, RunErrorEvent)):
                    if terminal is None or isinstance(event, RunErrorEvent):
                        terminal = event
                    continue
                yield event
        except Exception as error:
            if resuming_link_id is not None and self._governance is not None:
                await self._governance.mark_runtime_interrupt(
                    link_id=resuming_link_id,
                    status="failed",
                    error_code="workflow_runtime_error",
                )
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
            if resuming_link_id is not None and self._governance is not None:
                await self._governance.mark_runtime_interrupt(
                    link_id=resuming_link_id,
                    status="failed",
                    error_code=getattr(terminal, "code", None) or "workflow_resume_failed",
                )
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
            interrupt_contract: dict[str, str] | None = None
            for interrupt in getattr(outcome, "interrupts", ()) or ():
                interrupt_contract = _interrupt_contract(interrupt)
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
            if interrupt_contract is not None:
                waiting_executor_id = interrupt_contract["executor_id"]
            if self._checkpoint_storage_factory is not None:
                if self._governance is None or interrupt_contract is None:
                    await self._sessions.fail_active_run(
                        thread_id,
                        status="interrupted",
                        error_code="interrupt_contract_missing",
                        message="Workflow暂停，但无法建立持久Interrupt合同。",
                    )
                    yield RunErrorEvent(
                        message="Workflow暂停，但无法建立持久Interrupt合同。",
                        code="INTERRUPT_CONTRACT_MISSING",
                    )
                    return
                storage = self._checkpoint_storage_factory(accepted.product_run_id)
                workflow = self._resolve_workflow(thread_id)
                checkpoint = await storage.get_latest_pending(
                    workflow_name=workflow.name,
                    request_id=interrupt_contract["maf_request_id"],
                )
                if checkpoint is None:
                    await self._sessions.fail_active_run(
                        thread_id,
                        status="interrupted",
                        error_code="checkpoint_not_persisted",
                        message="Workflow已暂停，但MAF Checkpoint没有持久化，不能安全恢复。",
                    )
                    yield RunErrorEvent(
                        message="Workflow已暂停，但MAF Checkpoint没有持久化，不能安全恢复。",
                        code="CHECKPOINT_NOT_PERSISTED",
                    )
                    return
                await self._governance.bind_runtime_interrupt(
                    decision_request_id=interrupt_contract["decision_request_id"],
                    product_run_id=accepted.product_run_id,
                    maf_workflow_name=workflow.name,
                    maf_graph_signature_hash=workflow.graph_signature_hash,
                    maf_checkpoint_id=checkpoint.checkpoint_id,
                    maf_request_id=interrupt_contract["maf_request_id"],
                    maf_executor_id=interrupt_contract["executor_id"],
                    agui_thread_id=thread_id,
                    agui_run_id=agui_run_id,
                    agui_interrupt_id=interrupt_contract["agui_interrupt_id"],
                )
            if resuming_link_id is not None and self._governance is not None:
                await self._governance.mark_runtime_interrupt(
                    link_id=resuming_link_id,
                    status="resumed",
                )
            if waiting_executor_id is not None:
                self._waiting_nodes[thread_id] = waiting_executor_id
                waiting_payload = {
                    "workflow_id": self.definition.id,
                    "executor_id": waiting_executor_id,
                    "status": "in_progress",
                    "details": {
                        "message": ("请求已准备，等待用户审批后才会继续。"),
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
                    message_id=f"workflow-waiting-{waiting_executor_id}",
                    activity_type="executor",
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
            if resuming_link_id is not None and self._governance is not None:
                await self._governance.mark_runtime_interrupt(
                    link_id=resuming_link_id,
                    status="resumed",
                )
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

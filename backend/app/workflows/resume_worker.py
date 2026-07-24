"""Outbox handler that resumes a version-bound MAF workflow interrupt."""

from __future__ import annotations

import logging
from uuid import uuid4

from ..governance.outbox import ClaimedOutboxEvent, OutboxDispatchError
from ..governance.service import ExecutionGovernanceService
from ..runtime_execution.service import RuntimeExecutionService

logger = logging.getLogger(__name__)


class RuntimeResumeOutboxHandler:
    """Translate one committed Product decision into one canonical AG-UI Resume."""

    def __init__(
        self,
        governance: ExecutionGovernanceService,
        *,
        runtime: RuntimeExecutionService,
    ) -> None:
        self.governance = governance
        self.runtime = runtime

    async def __call__(self, event: ClaimedOutboxEvent) -> None:
        if event.event_type != "runtime.resume_requested":
            raise OutboxDispatchError(
                f"未注册Outbox事件类型: {event.event_type}",
                code="outbox_event_unsupported",
            )
        decision_request_id = str(event.payload.get("decision_request_id") or "")
        if not decision_request_id:
            raise OutboxDispatchError("Outbox缺少decision_request_id", code="outbox_payload_invalid")
        if event.payload.get("dispatch_required") is not True:
            # Compatibility path for decisions resolved by an already-running
            # AG-UI call. The outbox still records/proves the transaction but
            # must not start a second MAF continuation.
            return
        link = await self.governance.runtime_interrupt_for_request(decision_request_id=decision_request_id)
        if link.status in {"cancelled", "failed", "closed"}:
            logger.info(
                "runtime_resume_skipped_terminal_interrupt request_id=%s status=%s",
                decision_request_id,
                link.status,
            )
            return
        decisions = await self.governance.resolved_human_request(decision_request_id)
        if not decisions:
            raise OutboxDispatchError("决定请求没有item", code="decision_items_missing")
        if len(decisions) != 1:
            # Current ProductDecision/ModelCall executors each own one MAF
            # request. Batch Tool decisions will use an explicit request-id to
            # response map when their runtime node is introduced.
            raise OutboxDispatchError(
                "当前Runtime节点不支持把多个决定合并到一个MAF response",
                code="batch_resume_not_supported",
            )
        if link.status == "resumed":
            return
        decision = decisions[0]
        await self.governance.mark_runtime_interrupt(
            link_id=link.id,
            status="decision_recorded",
        )
        extra_payload = event.payload.get("response_payload")
        extra_payload = dict(extra_payload) if isinstance(extra_payload, dict) else {}
        input_data = {
            "threadId": link.agui_thread_id,
            "runId": f"outbox-resume-{uuid4()}",
            "state": {},
            "messages": [],
            "tools": [],
            "context": [],
            "forwardedProps": {"source": "governance_outbox", "dedupe_key": event.dedupe_key},
            "resume": [
                {
                    "interruptId": link.maf_request_id,
                    "status": "resolved",
                    "payload": {
                        **extra_payload,
                        "decision": decision["decision"],
                        "decision_recorded": True,
                    },
                }
            ],
        }
        await self.runtime.queue_checkpoint_resume(
            product_run_id=link.product_run_id,
            input_data=input_data,
            request_key=f"outbox:{event.dedupe_key}",
            checkpoint_id=link.maf_checkpoint_id,
            requested_by="governance_outbox",
        )
        logger.info(
            "runtime_resume_queued request_id=%s checkpoint_id=%s",
            decision_request_id,
            link.maf_checkpoint_id,
        )

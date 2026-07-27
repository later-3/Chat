"""Authoritative Plan ownership chain validation (第六轮复审 P0-1).

``WorkItem.current_plan_revision_id`` has no database FK, so the accepted
revision it points at must be re-proven along the whole chain on every use:

```text
WorkItem -> current_plan_revision_id -> TaskPlanRevision.task_plan_id
         -> TaskPlan(scope, work_item_id, project_id, status, current_revision_id)
```

This helper only *reads* inside the caller-owned ``AsyncSession``; it never
opens or commits a transaction (AGENTS.md §7.1).  Every consumer — draft-time
freeze, result prepare, and the Result Commit Gate — must run the same proof
instead of trusting the pointer.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .contracts import HarnessNotFound, HarnessValidationError
from .models import TaskPlanRecord, TaskPlanRevisionRecord, WorkItemRecord


async def require_current_plan_revision(
    transaction: AsyncSession,
    *,
    scope_id: str,
    work: WorkItemRecord,
    plan_revision_id: str,
) -> TaskPlanRevisionRecord:
    """Prove the accepted Plan revision genuinely belongs to this Work.

    Fails closed when any link is broken: missing revision, TaskPlan in another
    scope/Work/Project, a non-current or non-accepted revision, or a TaskPlan
    whose own current pointer or status no longer agrees.
    """

    revision = await transaction.get(TaskPlanRevisionRecord, plan_revision_id)
    if revision is None:
        raise HarnessNotFound("Work绑定的Plan revision不存在")
    plan = await transaction.get(TaskPlanRecord, revision.task_plan_id)
    if (
        plan is None
        or plan.scope_id != scope_id
        or plan.work_item_id != work.id
        or plan.project_id != work.project_id
    ):
        raise HarnessValidationError("Plan revision不属于该Work/Project/scope")
    if plan.current_revision_id != revision.id:
        raise HarnessValidationError("Plan revision已不再是TaskPlan的当前revision")
    if plan.status != "accepted":
        raise HarnessValidationError(f"TaskPlan当前状态{plan.status}，不是accepted")
    if revision.status != "accepted":
        raise HarnessValidationError(f"Plan revision当前状态{revision.status}，不是accepted")
    if work.current_plan_revision_id != revision.id:
        raise HarnessValidationError("Work的当前Plan revision与绑定revision不一致")
    return revision

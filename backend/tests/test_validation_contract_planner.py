"""第四轮复审P0-1：ValidationContractPlanner subject严格性攻击测试。"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest

from backend.app.collaboration_intents import models as _ci  # noqa: F401
from backend.app.collaboration_protocols import models as _cp  # noqa: F401

# 显式注册Schema依赖的模型模块，保证单文件独立收集（反例035）。
from backend.app.evidence import models as _ev  # noqa: F401
from backend.app.evidence.contracts import (
    EvidenceConflict,
    EvidenceValidationError,
    ResultEvidencePrerequisiteMissing,
)
from backend.app.evidence.validation_runtime import (
    ValidationCapabilityCatalog,
    default_validation_capabilities,
)
from backend.app.execution_dispatch.contracts import RepositoryFence
from backend.app.execution_dispatch.validation_contracts import ValidationContractPlanner
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.harness import models as _har  # noqa: F401
from backend.app.harness.service import HarnessService
from backend.app.product_sessions.database import ProductDatabase
from backend.app.project_resources import models as _pr  # noqa: F401
from backend.app.runtime_execution import models as _re  # noqa: F401
from backend.app.step_inputs import models as _si  # noqa: F401
from backend.app.tool_execution import models as _te  # noqa: F401

_OPEN: list[ProductDatabase] = []


def _run(scenario: Callable[[], Awaitable[None]]) -> None:
    async def run_and_close() -> None:
        first = len(_OPEN)
        try:
            await scenario()
        finally:
            for database in reversed(_OPEN[first:]):
                await database.close()
            del _OPEN[first:]

    asyncio.run(run_and_close())


async def _runtime(tmp_path: Path):
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    await database.initialize()
    _OPEN.append(database)
    harness = HarnessService(database)
    planner = ValidationContractPlanner(
        database,
        scope_id="local-user",
        capabilities=ValidationCapabilityCatalog(default_validation_capabilities()),
        compiler=None,
        repository_execution_context=None,  # type: ignore[arg-type]
    )
    return database, harness, planner


def _fence(project_id: str) -> RepositoryFence:
    return RepositoryFence(
        project_id=project_id,
        binding_id="binding-1",
        snapshot_id="snapshot-1",
        binding_generation=1,
        snapshot_sequence=1,
        semantic_hash="a" * 64,
        governance_manifest_hash="b" * 64,
        head_oid="c" * 40,
        worktree_fingerprint="d" * 64,
        root_key="code",
        relative_path="repo",
    )


def _item(action_id: str, revision: int) -> dict:
    return {
        "source_kind": "action_item",
        "source_id": action_id,
        "source_revision": revision,
        "adopted": True,
    }


async def _project_work_action(
    harness: HarnessService,
    *,
    title: str = "Chat",
    assignee: str = "agent",
    status: str = "ready",
    with_contract: bool = True,
):
    project = await harness.create_project(
        command_id=str(uuid.uuid4()), kind="delivery", title=title, goal="g", status="active"
    )
    work = await harness.create_work_item(
        command_id=str(uuid.uuid4()),
        project_id=project["id"],
        kind="task",
        title="task",
        objective="o",
        status="ready",
    )
    await harness.create_plan_revision(
        command_id=str(uuid.uuid4()),
        work_item_id=work["id"],
        expected_work_row_version=work["row_version"],
        summary="plan",
        nodes=[{"key": "n1", "title": "n1", "objective": "o"}],
        validation_contract=(
            {
                "rules": [
                    {
                        "capability_key": "pytest-suite",
                        "capability_version": "1.0.0",
                        "params": {"targets": ["tests"]},
                    }
                ]
            }
            if with_contract
            else {}
        ),
        accept=True,
    )
    view = await harness.get_work_item(work["id"])
    await harness.transition_work_item(
        command_id=str(uuid.uuid4()),
        work_item_id=work["id"],
        expected_row_version=view["work_item"]["row_version"],
        target_status="in_progress",
        reason="start",
    )
    action = await harness.create_action_item(
        command_id=str(uuid.uuid4()),
        project_id=project["id"],
        work_item_id=work["id"],
        title="action",
        assignee_kind=assignee,
        status=status,
    )
    return project, work, action


def test_zero_adopted_action_returns_none(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, _, planner = await _runtime(tmp_path)
        assert await planner.freeze(context_items=[], fence=_fence("p-any")) is None

    _run(scenario)


def test_two_adopted_actions_fail_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, harness, planner = await _runtime(tmp_path)
        project, work, action_a = await _project_work_action(harness)
        action_b = await harness.create_action_item(
            command_id=str(uuid.uuid4()),
            project_id=project["id"],
            work_item_id=work["id"],
            title="action-b",
            assignee_kind="agent",
            status="ready",
        )
        with pytest.raises(EvidenceValidationError, match="多个Action"):
            await planner.freeze(
                context_items=[_item(action_a["id"], 1), _item(action_b["id"], 1)],
                fence=_fence(project["id"]),
            )

    _run(scenario)


def test_same_action_conflicting_revisions_fail_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, harness, planner = await _runtime(tmp_path)
        project, _, action = await _project_work_action(harness)
        with pytest.raises(EvidenceConflict, match="revision不一致"):
            await planner.freeze(
                context_items=[_item(action["id"], 1), _item(action["id"], 2)],
                fence=_fence(project["id"]),
            )

    _run(scenario)


def test_missing_action_fails_closed_instead_of_none(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, _, planner = await _runtime(tmp_path)
        with pytest.raises(EvidenceValidationError, match="不存在"):
            await planner.freeze(
                context_items=[_item(str(uuid.uuid4()), 1)],
                fence=_fence("p-any"),
            )

    _run(scenario)


def test_action_project_mismatch_with_fence_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, harness, planner = await _runtime(tmp_path)
        project, _, action = await _project_work_action(harness, title="Chat")
        with pytest.raises(EvidenceValidationError, match="Project"):
            await planner.freeze(
                context_items=[_item(action["id"], 1)],
                fence=_fence(str(uuid.uuid4())),
            )

    _run(scenario)


def test_parent_work_not_in_progress_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, harness, planner = await _runtime(tmp_path)
        project, work, action = await _project_work_action(harness)
        view = await harness.get_work_item(work["id"])
        await harness.transition_work_item(
            command_id=str(uuid.uuid4()),
            work_item_id=work["id"],
            expected_row_version=view["work_item"]["row_version"],
            target_status="blocked",
            reason="pause",
        )
        with pytest.raises(EvidenceValidationError, match="in_progress"):
            await planner.freeze(
                context_items=[_item(action["id"], 1)],
                fence=_fence(project["id"]),
            )

    _run(scenario)


def test_user_assignee_action_fails_closed_instead_of_none(tmp_path: Path) -> None:
    """唯一user/external Action不是“无主体”：主Workflow无权自动完成，稳定失败。"""

    async def scenario() -> None:
        _, harness, planner = await _runtime(tmp_path)
        project, _, action = await _project_work_action(harness, assignee="user")
        with pytest.raises(EvidenceValidationError, match="无权自动完成"):
            await planner.freeze(
                context_items=[_item(action["id"], 1)],
                fence=_fence(project["id"]),
            )

    _run(scenario)


def test_subject_without_contract_rules_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        _, harness, planner = await _runtime(tmp_path)
        project, _, action = await _project_work_action(harness, with_contract=False)
        with pytest.raises(ResultEvidencePrerequisiteMissing):
            await planner.freeze(
                context_items=[_item(action["id"], 1)],
                fence=_fence(project["id"]),
            )

    _run(scenario)


def test_tampered_task_plan_pointer_fails_freeze(tmp_path: Path) -> None:
    """TaskPlan归属/active pointer被改后，冻结必须fail closed而不是沿用旧revision。"""

    async def scenario() -> None:
        database, harness, planner = await _runtime(tmp_path)
        project, work, action = await _project_work_action(harness)

        from backend.app.harness.models import TaskPlanRecord, TaskPlanRevisionRecord

        async with database.sessions.begin() as txn:
            from backend.app.harness.models import WorkItemRecord as _Work

            work_row = await txn.get(_Work, work["id"])
            assert work_row is not None and work_row.current_plan_revision_id
            revision = await txn.get(TaskPlanRevisionRecord, work_row.current_plan_revision_id)
            assert revision is not None
            plan = await txn.get(TaskPlanRecord, revision.task_plan_id)
            assert plan is not None
            plan.current_revision_id = None
        with pytest.raises(EvidenceValidationError, match="当前revision|不是accepted"):
            await planner.freeze(
                context_items=[_item(action["id"], 1)],
                fence=_fence(project["id"]),
            )

    _run(scenario)

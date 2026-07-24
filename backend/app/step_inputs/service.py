"""Create and query immutable Workflow step input projections."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import func, select

from ..harness.contracts import content_hash, new_id, normalized_text
from ..observability.context import bind_context
from ..product_sessions.database import ProductDatabase, RunRecord, utc_now
from .models import StepInputProjectionRecord

logger = logging.getLogger(__name__)


class StepInputProjectionService:
    """Persist only public step inputs, never hidden reasoning or raw secrets."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database = database
        self._clock = clock

    async def record(
        self,
        *,
        run_id: str,
        workflow_definition_id: str,
        workflow_version: str,
        node_id: str,
        input_value: Mapping[str, Any],
        agent_profile_key: str | None = None,
        context_package_id: str | None = None,
        protocol_definition_id: str | None = None,
        protocol_binding_id: str | None = None,
        run_spec_id: str | None = None,
        capability_allowlist: Sequence[Mapping[str, Any]] = (),
        budget: Mapping[str, Any] | None = None,
        output_contract: Mapping[str, Any] | None = None,
        stop_conditions: Sequence[Mapping[str, Any] | str] = (),
    ) -> dict[str, Any]:
        workflow_id = normalized_text(
            workflow_definition_id,
            field="workflow_definition_id",
            max_length=100,
        )
        version = normalized_text(
            workflow_version,
            field="workflow_version",
            max_length=40,
        )
        step_id = normalized_text(node_id, field="node_id", max_length=120)
        payload = {
            "run_id": run_id,
            "workflow_definition_id": workflow_id,
            "workflow_version": version,
            "node_id": step_id,
            "agent_profile_key": agent_profile_key,
            "context_package_id": context_package_id,
            "protocol_definition_id": protocol_definition_id,
            "protocol_binding_id": protocol_binding_id,
            "run_spec_id": run_spec_id,
            "input": dict(input_value),
            "capability_allowlist": [dict(value) for value in capability_allowlist],
            "budget": dict(budget or {}),
            "output_contract": dict(output_contract or {}),
            "stop_conditions": [
                dict(value) if isinstance(value, Mapping) else str(value) for value in stop_conditions
            ],
        }
        projection_hash = content_hash(payload)
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise ValueError("StepInputProjection关联的Product Run不存在")
            latest = await transaction.scalar(
                select(StepInputProjectionRecord)
                .where(
                    StepInputProjectionRecord.run_id == run_id,
                    StepInputProjectionRecord.node_id == step_id,
                )
                .order_by(StepInputProjectionRecord.projection_revision.desc())
                .limit(1)
            )
            if latest is not None and latest.projection_hash == projection_hash:
                return self._view(latest)
            revision = (
                int(
                    await transaction.scalar(
                        select(func.max(StepInputProjectionRecord.projection_revision)).where(
                            StepInputProjectionRecord.run_id == run_id,
                            StepInputProjectionRecord.node_id == step_id,
                        )
                    )
                    or 0
                )
                + 1
            )
            value = StepInputProjectionRecord(
                id=new_id(),
                run_id=run_id,
                workflow_definition_id=workflow_id,
                workflow_version=version,
                node_id=step_id,
                projection_revision=revision,
                agent_profile_key=agent_profile_key,
                context_package_id=context_package_id,
                protocol_definition_id=protocol_definition_id,
                protocol_binding_id=protocol_binding_id,
                run_spec_id=run_spec_id,
                input_json=dict(input_value),
                capability_allowlist_json=[dict(item) for item in capability_allowlist],
                budget_json=dict(budget or {}),
                output_contract_json=dict(output_contract or {}),
                stop_conditions_json=[
                    dict(item) if isinstance(item, Mapping) else str(item) for item in stop_conditions
                ],
                projection_hash=projection_hash,
                created_at=self._clock(),
            )
            transaction.add(value)
        with bind_context(
            product_run_id=run_id,
            workflow_id=workflow_id,
            workflow_node_id=step_id,
        ):
            logger.info(
                "step_input_projection_recorded revision=%d projection_hash=%s capability_count=%d",
                value.projection_revision,
                value.projection_hash[:12],
                len(capability_allowlist),
            )
        return self._view(value)

    async def list_for_run(self, run_id: str) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(StepInputProjectionRecord)
                        .where(StepInputProjectionRecord.run_id == run_id)
                        .order_by(
                            StepInputProjectionRecord.created_at,
                            StepInputProjectionRecord.node_id,
                            StepInputProjectionRecord.projection_revision,
                        )
                    )
                ).all()
            )
        return [self._view(value) for value in values]

    @staticmethod
    def _view(value: StepInputProjectionRecord) -> dict[str, Any]:
        created_at = value.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return {
            "id": value.id,
            "run_id": value.run_id,
            "workflow_definition_id": value.workflow_definition_id,
            "workflow_version": value.workflow_version,
            "node_id": value.node_id,
            "projection_revision": value.projection_revision,
            "agent_profile_key": value.agent_profile_key,
            "context_package_id": value.context_package_id,
            "protocol_definition_id": value.protocol_definition_id,
            "protocol_binding_id": value.protocol_binding_id,
            "run_spec_id": value.run_spec_id,
            "input": dict(value.input_json or {}),
            "capability_allowlist": list(value.capability_allowlist_json or []),
            "budget": dict(value.budget_json or {}),
            "output_contract": dict(value.output_contract_json or {}),
            "stop_conditions": list(value.stop_conditions_json or []),
            "projection_hash": value.projection_hash,
            "created_at": created_at.isoformat(),
        }

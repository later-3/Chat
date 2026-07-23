"""Durable, Product-scoped storage for Microsoft Agent Framework checkpoints.

MAF owns the checkpoint payload and restore algorithm.  This adapter adds the
Product Run/Attempt and workflow-version binding required to authorize a
cross-process restore.  The only private MAF dependency is the same restricted
JSON encoder used by ``FileCheckpointStorage``; compatibility is locked by
tests against the installed framework version.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from agent_framework import WorkflowCheckpoint, WorkflowCheckpointException
from agent_framework._workflows._checkpoint_encoding import (  # pyright: ignore[reportPrivateUsage]
    decode_checkpoint_value,
    encode_checkpoint_value,
)
from sqlalchemy import select

from ..governance.models import MafWorkflowCheckpointRecord
from ..product_sessions.database import ProductDatabase, RunAttemptRecord


logger = logging.getLogger(__name__)

_ALLOWED_APPLICATION_CHECKPOINT_TYPES = frozenset(
    {
        "app.workflows.continuous_chat:CollaborationState",
        "backend.app.workflows.continuous_chat:CollaborationState",
    }
)


class ProductCheckpointConflict(WorkflowCheckpointException):
    """The checkpoint exists but is not valid for the requested Product scope."""


class ProductWorkflowCheckpointStorage:
    """Implement MAF ``CheckpointStorage`` for one immutable Product Run scope."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        product_run_id: str,
        workflow_definition_id: str,
        workflow_version: str,
        allowed_checkpoint_types: set[str] | frozenset[str] | None = None,
    ) -> None:
        self.database = database
        self.product_run_id = product_run_id
        self.workflow_definition_id = workflow_definition_id
        self.workflow_version = workflow_version
        self._allowed_types = frozenset(allowed_checkpoint_types or ()) | _ALLOWED_APPLICATION_CHECKPOINT_TYPES

    async def save(self, checkpoint: WorkflowCheckpoint) -> str:
        encoded = encode_checkpoint_value(checkpoint.to_dict())
        pending_request_ids = sorted(str(value) for value in checkpoint.pending_request_info_events)
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.get(MafWorkflowCheckpointRecord, checkpoint.checkpoint_id)
            if existing is not None:
                if (
                    existing.product_run_id != self.product_run_id
                    or existing.graph_signature_hash != checkpoint.graph_signature_hash
                ):
                    raise ProductCheckpointConflict("Checkpoint ID已经绑定其他Product Run或Workflow图")
                return checkpoint.checkpoint_id
            attempt = await transaction.scalar(
                select(RunAttemptRecord)
                .where(RunAttemptRecord.run_id == self.product_run_id)
                .order_by(RunAttemptRecord.attempt_number.desc())
            )
            if attempt is None:
                raise ProductCheckpointConflict("Product Run没有可绑定的Run Attempt")
            transaction.add(
                MafWorkflowCheckpointRecord(
                    checkpoint_id=checkpoint.checkpoint_id,
                    product_run_id=self.product_run_id,
                    run_attempt_id=attempt.id,
                    workflow_definition_id=self.workflow_definition_id,
                    workflow_version=self.workflow_version,
                    workflow_name=checkpoint.workflow_name,
                    graph_signature_hash=checkpoint.graph_signature_hash,
                    previous_checkpoint_id=checkpoint.previous_checkpoint_id,
                    iteration_count=checkpoint.iteration_count,
                    pending_request_ids_json=pending_request_ids,
                    encoded_checkpoint_json=encoded,
                )
            )
        logger.info(
            "maf_checkpoint_saved run_id=%s workflow=%s checkpoint_id=%s pending_requests=%d",
            self.product_run_id,
            checkpoint.workflow_name,
            checkpoint.checkpoint_id,
            len(pending_request_ids),
        )
        return checkpoint.checkpoint_id

    async def load(self, checkpoint_id: str) -> WorkflowCheckpoint:
        async with self.database.sessions() as transaction:
            record = await transaction.get(MafWorkflowCheckpointRecord, checkpoint_id)
        if record is None or record.product_run_id != self.product_run_id:
            raise WorkflowCheckpointException(f"No checkpoint found with ID {checkpoint_id}")
        if record.workflow_definition_id != self.workflow_definition_id:
            raise ProductCheckpointConflict("Checkpoint Workflow Definition不匹配")
        if record.workflow_version != self.workflow_version:
            raise ProductCheckpointConflict("Checkpoint Workflow版本不匹配")
        if record.status not in {"available", "linked", "resuming", "resumed"}:
            raise ProductCheckpointConflict(f"Checkpoint状态不允许恢复: {record.status}")
        try:
            decoded = decode_checkpoint_value(
                record.encoded_checkpoint_json,
                allowed_types=self._allowed_types,
            )
            checkpoint = WorkflowCheckpoint.from_dict(decoded)
        except WorkflowCheckpointException:
            raise
        except Exception as error:  # pragma: no cover - defensive corruption boundary
            raise WorkflowCheckpointException(f"Failed to decode checkpoint {checkpoint_id}") from error
        if checkpoint.graph_signature_hash != record.graph_signature_hash:
            raise ProductCheckpointConflict("Checkpoint图签名与Product索引不一致")
        logger.info(
            "maf_checkpoint_loaded run_id=%s workflow=%s checkpoint_id=%s pending_requests=%d",
            self.product_run_id,
            checkpoint.workflow_name,
            checkpoint.checkpoint_id,
            len(checkpoint.pending_request_info_events),
        )
        return checkpoint

    async def list_checkpoints(self, *, workflow_name: str) -> list[WorkflowCheckpoint]:
        records = await self._records(workflow_name=workflow_name)
        return [await self.load(value.checkpoint_id) for value in records]

    async def delete(self, checkpoint_id: str) -> bool:
        async with self.database.sessions.begin() as transaction:
            record = await transaction.get(MafWorkflowCheckpointRecord, checkpoint_id)
            if record is None or record.product_run_id != self.product_run_id:
                return False
            record.status = "deleted"
        return True

    async def get_latest(self, *, workflow_name: str) -> WorkflowCheckpoint | None:
        records = await self._records(workflow_name=workflow_name, limit=1)
        return await self.load(records[0].checkpoint_id) if records else None

    async def get_latest_pending(
        self,
        *,
        workflow_name: str,
        request_id: str | None = None,
    ) -> WorkflowCheckpoint | None:
        records = await self._records(workflow_name=workflow_name)
        for record in records:
            pending = set(record.pending_request_ids_json or ())
            if pending and (request_id is None or request_id in pending):
                return await self.load(record.checkpoint_id)
        return None

    async def list_checkpoint_ids(self, *, workflow_name: str) -> list[str]:
        return [value.checkpoint_id for value in await self._records(workflow_name=workflow_name)]

    async def _records(
        self,
        *,
        workflow_name: str,
        limit: int | None = None,
    ) -> list[MafWorkflowCheckpointRecord]:
        async with self.database.sessions() as transaction:
            query = (
                select(MafWorkflowCheckpointRecord)
                .where(
                    MafWorkflowCheckpointRecord.product_run_id == self.product_run_id,
                    MafWorkflowCheckpointRecord.workflow_definition_id == self.workflow_definition_id,
                    MafWorkflowCheckpointRecord.workflow_version == self.workflow_version,
                    MafWorkflowCheckpointRecord.workflow_name == workflow_name,
                    MafWorkflowCheckpointRecord.status != "deleted",
                )
                .order_by(MafWorkflowCheckpointRecord.created_at.desc())
            )
            if limit is not None:
                query = query.limit(limit)
            return list((await transaction.scalars(query)).all())


CheckpointStorageFactory = Callable[[str], ProductWorkflowCheckpointStorage]

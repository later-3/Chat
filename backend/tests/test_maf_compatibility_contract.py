"""Installed-version upgrade gate for Chat's MAF and AG-UI adapter boundary."""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from agent_framework import (
    Executor,
    InMemoryCheckpointStorage,
    WorkflowBuilder,
    WorkflowCheckpoint,
    WorkflowCheckpointException,
    WorkflowContext,
    handler,
)
from agent_framework_ag_ui import AGUIRequest

from backend.app.runtime_adapters import (
    EXPECTED_RUNTIME_PACKAGES,
    MAF_REFERENCE_COMMIT,
    RuntimeCompatibilityError,
    assert_runtime_compatibility,
    decode_checkpoint_payload,
    encode_checkpoint_payload,
    installed_runtime_versions,
    maf_is_instance,
    pending_request_ids,
    restore_workflow_checkpoint,
)


class EchoExecutor(Executor):
    def __init__(self) -> None:
        super().__init__(id="echo")

    @handler
    async def echo(self, value: str, ctx: WorkflowContext[str, str]) -> None:
        await ctx.yield_output(value)


@dataclass
class UnapprovedCheckpointValue:
    value: str


def test_installed_runtime_versions_and_public_agui_contract_are_locked() -> None:
    assert installed_runtime_versions() == dict(EXPECTED_RUNTIME_PACKAGES)
    assert assert_runtime_compatibility() == dict(EXPECTED_RUNTIME_PACKAGES)
    assert len(MAF_REFERENCE_COMMIT) == 40
    assert {"messages", "run_id", "thread_id", "resume"}.issubset(AGUIRequest.model_fields)
    assert any(base.__name__ == "RequestInfoMixin" for base in Executor.__mro__)


def test_runtime_version_drift_fails_closed_before_an_upgrade() -> None:
    incompatible = {**EXPECTED_RUNTIME_PACKAGES, "agent-framework-core": "999.0.0"}

    with pytest.raises(RuntimeCompatibilityError, match="Agent Runtime版本未通过兼容门"):
        assert_runtime_compatibility(incompatible)


def test_checkpoint_codec_round_trip_and_type_allow_list() -> None:
    checkpoint = WorkflowCheckpoint(
        workflow_name="compatibility-gate",
        graph_signature_hash="graph-hash",
        state={"step": 2},
        iteration_count=2,
    )
    encoded = encode_checkpoint_payload(checkpoint.to_dict())
    decoded = decode_checkpoint_payload(encoded, allowed_types=frozenset())

    assert WorkflowCheckpoint.from_dict(decoded).to_dict() == checkpoint.to_dict()

    unapproved = encode_checkpoint_payload({"value": UnapprovedCheckpointValue("private")})
    with pytest.raises(WorkflowCheckpointException):
        decode_checkpoint_payload(unapproved, allowed_types=frozenset())


@pytest.mark.anyio
async def test_private_restore_bridge_matches_installed_workflow_runner_contract() -> None:
    executor = EchoExecutor()
    workflow = WorkflowBuilder(
        start_executor=executor,
        name="compatibility-gate",
        output_from=[executor],
    ).build()
    storage = InMemoryCheckpointStorage()
    checkpoint = WorkflowCheckpoint(
        workflow_name=workflow.name,
        graph_signature_hash=workflow.graph_signature_hash,
    )
    await storage.save(checkpoint)

    assert await pending_request_ids(workflow) == frozenset()
    await restore_workflow_checkpoint(
        workflow,
        checkpoint_id=checkpoint.checkpoint_id,
        checkpoint_storage=storage,
    )
    assert maf_is_instance("message", str) is True
    assert maf_is_instance(42, str | int) is True

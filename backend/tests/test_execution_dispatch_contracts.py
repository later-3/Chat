from __future__ import annotations

import pytest

from backend.app.execution_dispatch.contracts import route_from_run_spec
from backend.app.execution_dispatch.service import ExecutionDispatchService
from backend.app.tool_configs import PiToolConfigSnapshot


def _fence() -> dict[str, object]:
    return {
        "project_id": "project-1",
        "binding_id": "binding-1",
        "snapshot_id": "snapshot-1",
        "binding_generation": 2,
        "snapshot_sequence": 4,
        "semantic_hash": "a" * 64,
        "governance_manifest_hash": "b" * 64,
        "head_oid": "c" * 40,
        "worktree_fingerprint": "d" * 64,
        "root_key": "workspace",
        "relative_path": "Chat",
    }


def test_answer_route_is_derived_only_from_run_spec() -> None:
    route = route_from_run_spec(
        run_spec_id="spec-1",
        run_spec_hash="hash-1",
        spec={"runtime_agent": {"runtime": "maf-workflow", "mode": "answer_only"}},
    )

    assert route.kind == "answer_only"
    assert route.repository_fence is None
    assert route.reason_code == "run_spec_selected_answer_only"


def test_pi_readonly_route_requires_complete_repository_fence() -> None:
    route = route_from_run_spec(
        run_spec_id="spec-2",
        run_spec_hash="hash-2",
        spec={
            "runtime_agent": {
                "runtime": "pi",
                "mode": "readonly",
                "repository_fence": _fence(),
            }
        },
    )

    assert route.kind == "pi_readonly"
    assert route.repository_fence is not None
    assert route.repository_fence.snapshot_sequence == 4
    assert route.public_view()["repository_fence"]["relative_path"] == "Chat"


@pytest.mark.parametrize(
    "runtime_agent",
    [
        {"runtime": "pi", "mode": "write", "repository_fence": _fence()},
        {"runtime": "pi", "mode": "readonly"},
        {"runtime": "unknown"},
    ],
)
def test_execution_route_fails_closed_for_unsupported_or_incomplete_runtime(
    runtime_agent: dict[str, object],
) -> None:
    with pytest.raises(ValueError):
        route_from_run_spec(
            run_spec_id="spec-3",
            run_spec_hash="hash-3",
            spec={"runtime_agent": runtime_agent},
        )


def test_sd2_readonly_config_cannot_expand_the_approved_budget(tmp_path) -> None:
    configured = PiToolConfigSnapshot(
        enabled=True,
        provider_id="provider",
        model="model",
        working_directory=str(tmp_path),
        allowed_tools=("read", "grep", "find", "ls", "bash"),
        thinking_level="medium",
        max_model_calls=100,
        timeout_seconds=3_600,
        system_prompt="遵守治理规则。",
        revision=3,
    )

    bounded = ExecutionDispatchService._readonly_config(
        configured,
        working_directory=str(tmp_path),
    )

    assert bounded.allowed_tools == ("read", "grep", "find", "ls")
    assert bounded.max_model_calls == 6
    assert bounded.timeout_seconds == 600

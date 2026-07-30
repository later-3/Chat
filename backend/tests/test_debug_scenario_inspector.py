from __future__ import annotations

import importlib.util
from pathlib import Path


def _module():
    path = Path(__file__).resolve().parents[2] / "scripts" / "inspect-debug-scenario.py"
    spec = importlib.util.spec_from_file_location("inspect_debug_scenario", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_scenario_node_oracle_reports_missing_and_forbidden_nodes() -> None:
    result = _module().evaluate_nodes(
        {
            "required_nodes": ["input_acceptance", "scenario_router"],
            "forbidden_nodes": ["pi_workspace_dispatch"],
        },
        ["input_acceptance", "pi_workspace_dispatch"],
    )

    assert result == {
        "required_count": 2,
        "actual_node_count": 2,
        "missing_required_nodes": ["scenario_router"],
        "unexpected_forbidden_nodes": ["pi_workspace_dispatch"],
        "node_oracle_passed": False,
    }


def test_scenario_node_oracle_accepts_extra_non_forbidden_nodes() -> None:
    result = _module().evaluate_nodes(
        {
            "required_nodes": ["input_acceptance"],
            "forbidden_nodes": ["clarification"],
        },
        ["input_acceptance", "context_candidates"],
    )

    assert result["node_oracle_passed"] is True
    assert result["missing_required_nodes"] == []
    assert result["unexpected_forbidden_nodes"] == []

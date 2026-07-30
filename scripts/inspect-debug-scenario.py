#!/usr/bin/env python3
"""Compare one terminal Product Run with a project-mastery scenario node oracle.

The command deliberately prints only IDs, statuses, counts and node names.  It
does not print prompts, Provider payloads, Context bodies or model output.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCENARIO_MANIFEST = ROOT / "项目掌握" / "调试实战" / "scenario-manifest.json"


def _request_json(base_url: str, path: str) -> dict[str, Any]:
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}")
    with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310 - local operator URL
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"接口没有返回JSON对象：{path}")
    return value


def _scenario(scenario_id: str) -> dict[str, Any]:
    manifest = json.loads(SCENARIO_MANIFEST.read_text(encoding="utf-8"))
    for scenario in manifest["scenarios"]:
        if scenario["id"] == scenario_id:
            return scenario
    raise ValueError(f"未知场景ID：{scenario_id}")


def evaluate_nodes(scenario: dict[str, Any], actual_nodes: list[str]) -> dict[str, Any]:
    """Return a non-sensitive required/forbidden node comparison."""

    actual = set(actual_nodes)
    required = set(map(str, scenario.get("required_nodes", [])))
    forbidden = set(map(str, scenario.get("forbidden_nodes", [])))
    missing = sorted(required - actual)
    unexpected = sorted(forbidden & actual)
    return {
        "required_count": len(required),
        "actual_node_count": len(actual),
        "missing_required_nodes": missing,
        "unexpected_forbidden_nodes": unexpected,
        "node_oracle_passed": not missing and not unexpected,
    }


def _model_attempt_count(governance: dict[str, Any] | None) -> int | None:
    if governance is None:
        return None
    count = 0
    for call in governance.get("model_calls", []):
        for revision in call.get("revisions", []):
            count += len(revision.get("attempts", []))
    return count


def inspect_run(
    *,
    base_url: str,
    scenario_id: str,
    session_id: str,
    run_id: str,
) -> dict[str, Any]:
    scenario = _scenario(scenario_id)
    runs = _request_json(base_url, f"/api/sessions/{session_id}/runs").get("runs", [])
    run = next((value for value in runs if value.get("id") == run_id), None)
    if run is None:
        raise ValueError("Product Run不属于指定Product Session，或REST投影中不存在")
    reports = _request_json(
        base_url,
        f"/api/sessions/{session_id}/runs/{run_id}/trace-reports",
    ).get("reports", [])
    human_report = next((value for value in reports if value.get("report_kind") == "human"), None)
    if human_report is None:
        raise ValueError("终态human Trace报告不存在；活动Run请先等终态，不能用当前代码猜路径")
    content = human_report.get("content") or {}
    actual_path = content.get("actual_path") or []
    actual_nodes = [str(value.get("node_id")) for value in actual_path if value.get("node_id")]
    governance: dict[str, Any] | None
    try:
        governance = _request_json(base_url, f"/api/runs/{run_id}/governance")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            governance = None
        else:
            raise
    result = {
        "scenario_id": scenario_id,
        "scenario_title": scenario["title"],
        "oracle_level": scenario["oracle"],
        "product_session_id": session_id,
        "product_run_id": run_id,
        "product_run_status": run.get("status"),
        "workflow_id": content.get("workflow", {}).get("id"),
        "workflow_version": content.get("workflow", {}).get("version"),
        "trace_report_schema_version": human_report.get("schema_version"),
        "source_event_count": human_report.get("source_event_count"),
        "model_attempt_count": _model_attempt_count(governance),
        **evaluate_nodes(scenario, actual_nodes),
    }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", required=True, help="场景ID，例如SC01")
    parser.add_argument("--session-id", required=True, help="Product Session ID")
    parser.add_argument("--run-id", required=True, help="Product Run ID")
    parser.add_argument("--base-url", default="http://127.0.0.1:8030")
    parser.add_argument("--json", action="store_true", help="输出JSON而不是人读摘要")
    args = parser.parse_args()
    try:
        result = inspect_run(
            base_url=args.base_url,
            scenario_id=args.scenario,
            session_id=args.session_id,
            run_id=args.run_id,
        )
    except (ValueError, OSError, urllib.error.HTTPError) as error:
        raise SystemExit(f"ERROR: {error}") from error
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"场景：{result['scenario_id']} {result['scenario_title']}")
        print(f"Product Run：{result['product_run_id']} · {result['product_run_status']}")
        print(f"Workflow：{result['workflow_id']}@{result['workflow_version']}")
        print(
            "节点预言机："
            f"required={result['required_count']}，actual={result['actual_node_count']}，"
            f"missing={result['missing_required_nodes']}，"
            f"unexpected={result['unexpected_forbidden_nodes']}"
        )
        print(f"模型Attempt：{result['model_attempt_count']}")
        print("结果：节点预言机通过" if result["node_oracle_passed"] else "结果：节点预言机不通过")
    if not result["node_oracle_passed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()

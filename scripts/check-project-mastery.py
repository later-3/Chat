#!/usr/bin/env python3
"""Fail when project-mastery coverage drifts from top-level code or Workflow facts."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Never

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "项目掌握" / "coverage-manifest.json"
SCENARIO_MANIFEST = ROOT / "项目掌握" / "调试实战" / "scenario-manifest.json"
MASTERY_ROOT = ROOT / "项目掌握"
PROPOSAL = ROOT / "docs" / "overall-architecture-proposal.md"
MAIN_WORKFLOW_DOC = MASTERY_ROOT / "Workflow架构与ProductAwareWorkflow" / "持续协作主Workflow的39节点设计.md"


def _fail(message: str) -> Never:
    raise SystemExit(f"ERROR: {message}")


def _surface_paths(directory: Path) -> set[str]:
    values: set[str] = set()
    for path in directory.iterdir():
        if path.name in {"__init__.py", "__pycache__"}:
            continue
        if path.is_dir() or path.suffix == ".py":
            values.add(path.relative_to(ROOT).as_posix())
    return values


def _frontend_root_paths() -> set[str]:
    return {
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "frontend" / "src").iterdir()
        if path.is_file() and path.suffix in {".ts", ".tsx", ".css"}
    }


def _entry_paths(values: list[dict[str, Any]]) -> set[str]:
    return {str(value["path"]) for value in values}


def _check_exact(label: str, actual: set[str], expected: set[str]) -> None:
    missing = sorted(actual - expected)
    stale = sorted(expected - actual)
    if missing or stale:
        _fail(f"{label}覆盖漂移；未登记={missing}；已失效={stale}")


def _target_module_names() -> set[str]:
    text = PROPOSAL.read_text(encoding="utf-8")
    section = text.split("## 7. 产品与应用模块", 1)[1].split("## 8. MAF运行适配器", 1)[0]
    names = set()
    for heading in re.findall(r"^### 7\.\d+ (.+)$", section, flags=re.MULTILINE):
        names.add(heading.removesuffix("模块").strip())
    return names


def _check_debug_scenarios(*, workflow_nodes: set[str]) -> int:
    """Keep executable scenario docs, pytest evidence and node oracles connected."""

    manifest = json.loads(SCENARIO_MANIFEST.read_text(encoding="utf-8"))
    scenarios = manifest.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        _fail("调试场景清单必须包含非空scenarios")
    scenario_ids = [str(value.get("id")) for value in scenarios]
    if len(scenario_ids) != len(set(scenario_ids)):
        _fail("调试场景清单存在重复ID")
    metadata_pattern = re.compile(
        r"<!-- debug-scenario: id=(?P<id>SC\d+); status=(?P<status>[^;]+); "
        r"oracle=(?P<oracle>[^ ]+) -->"
    )
    allowed_statuses = {"current", "conditional", "target_gap"}
    allowed_oracles = set(manifest.get("oracle_levels", {}))
    for scenario in scenarios:
        scenario_id = str(scenario["id"])
        status = str(scenario["status"])
        oracle = str(scenario["oracle"])
        if status not in allowed_statuses:
            _fail(f"调试场景{scenario_id}使用未知状态：{status}")
        if oracle not in allowed_oracles:
            _fail(f"调试场景{scenario_id}使用未知预言机等级：{oracle}")
        document = ROOT / str(scenario["doc"])
        if not document.exists():
            _fail(f"调试场景{scenario_id}文档不存在：{scenario['doc']}")
        metadata = metadata_pattern.search(document.read_text(encoding="utf-8"))
        if metadata is None:
            _fail(f"调试场景{scenario_id}文档缺少机器元数据")
        if metadata.groupdict() != {"id": scenario_id, "status": status, "oracle": oracle}:
            _fail(
                f"调试场景{scenario_id}文档元数据漂移；"
                f"文档={metadata.groupdict()}；清单={{'id': '{scenario_id}', 'status': '{status}', "
                f"'oracle': '{oracle}'}}"
            )
        required_nodes = set(map(str, scenario.get("required_nodes", [])))
        forbidden_nodes = set(map(str, scenario.get("forbidden_nodes", [])))
        unknown_nodes = (required_nodes | forbidden_nodes) - workflow_nodes
        if unknown_nodes:
            _fail(f"调试场景{scenario_id}引用未知Workflow节点：{sorted(unknown_nodes)}")
        overlap = required_nodes & forbidden_nodes
        if overlap:
            _fail(f"调试场景{scenario_id}同时要求并禁止节点：{sorted(overlap)}")
        tests = scenario.get("tests", [])
        if status in {"current", "conditional"} and not tests:
            _fail(f"调试场景{scenario_id}没有绑定自动证据")
        for test_reference in tests:
            test_path_text, separator, test_name = str(test_reference).partition("::")
            if not separator or not test_name.startswith("test_"):
                _fail(f"调试场景{scenario_id}测试引用格式无效：{test_reference}")
            test_path = ROOT / test_path_text
            if not test_path.exists():
                _fail(f"调试场景{scenario_id}测试文件不存在：{test_path_text}")
            test_text = test_path.read_text(encoding="utf-8")
            if (
                re.search(rf"^(?:async\s+)?def\s+{re.escape(test_name)}\s*\(", test_text, re.MULTILINE)
                is None
            ):
                _fail(f"调试场景{scenario_id}测试函数不存在：{test_reference}")
    return len(scenarios)


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    units = {str(value["id"]) for value in manifest["learning_units"]}
    if len(units) != len(manifest["learning_units"]):
        _fail("learning_units存在重复ID")

    for section_name in (
        "target_modules",
        "backend_surfaces",
        "frontend_feature_surfaces",
        "frontend_root_surfaces",
        "workflow_catalog",
        "continuous_workflow_learning_stages",
        "continuous_workflow_nodes",
        "runtime_roles",
        "protocol_boundaries",
        "state_locations",
        "quality_and_delivery_surfaces",
    ):
        keys = [
            str(entry.get("id") or entry.get("path") or entry.get("name")) for entry in manifest[section_name]
        ]
        if len(keys) != len(set(keys)):
            _fail(f"{section_name}存在重复条目")
        for entry in manifest[section_name]:
            unknown = set(entry["units"]) - units
            if unknown:
                _fail(f"{section_name}的{entry}引用未知学习单元{sorted(unknown)}")

    for unit in manifest["learning_units"]:
        for relative in unit.get("docs", []):
            if not (ROOT / relative).exists():
                _fail(f"学习单元{unit['id']}引用不存在文档：{relative}")

    _check_exact(
        "11个目标产品模块",
        _target_module_names(),
        {str(value["name"]) for value in manifest["target_modules"]},
    )
    _check_exact(
        "后端顶层源码面",
        _surface_paths(ROOT / "backend" / "app"),
        _entry_paths(manifest["backend_surfaces"]),
    )
    _check_exact(
        "前端Feature面",
        {
            path.relative_to(ROOT).as_posix()
            for path in (ROOT / "frontend" / "src" / "features").iterdir()
            if path.is_dir()
        },
        _entry_paths(manifest["frontend_feature_surfaces"]),
    )
    _check_exact(
        "前端根源码面",
        _frontend_root_paths(),
        _entry_paths(manifest["frontend_root_surfaces"]),
    )

    sys.path.insert(0, str(ROOT))
    from backend.app.continuous_workflow_learning import (  # noqa: PLC0415
        CONTINUOUS_WORKFLOW_LEARNING_STAGES,
    )
    from backend.app.workflows.catalog import (  # noqa: PLC0415
        CONTINUOUS_COLLABORATION_WORKFLOW,
        WORKFLOW_CATALOG,
    )

    _check_exact(
        "Workflow目录",
        {value.id for value in WORKFLOW_CATALOG},
        {str(value["id"]) for value in manifest["workflow_catalog"]},
    )
    _check_exact(
        "持续协作主Workflow节点",
        {value.id for value in CONTINUOUS_COLLABORATION_WORKFLOW.nodes},
        {str(value["id"]) for value in manifest["continuous_workflow_nodes"]},
    )
    scenario_count = _check_debug_scenarios(
        workflow_nodes={value.id for value in CONTINUOUS_COLLABORATION_WORKFLOW.nodes}
    )

    code_stages = list(CONTINUOUS_WORKFLOW_LEARNING_STAGES)
    manifest_stages = manifest["continuous_workflow_learning_stages"]
    if [stage.id for stage in code_stages] != [str(value["id"]) for value in manifest_stages]:
        _fail("主Workflow学习阶段顺序与代码事实不一致")

    catalog_node_order = [value.id for value in CONTINUOUS_COLLABORATION_WORKFLOW.nodes]
    flattened_learning_nodes = [node_id for stage in code_stages for node_id in stage.node_ids]
    if flattened_learning_nodes != catalog_node_order:
        _fail("代码中的S1-S7没有按当前Workflow Definition顺序完整覆盖39个节点")

    stage_metadata_pattern = re.compile(
        r"<!-- workflow-learning-stage: (?P<id>S\d+); nodes: (?P<nodes>[^>]+) -->"
    )
    for code_stage, manifest_stage in zip(code_stages, manifest_stages, strict=True):
        if str(manifest_stage["name"]) != code_stage.name:
            _fail(f"{code_stage.id}名称与代码事实不一致")
        if list(manifest_stage["nodes"]) != list(code_stage.node_ids):
            _fail(f"{code_stage.id}节点范围与代码事实不一致")
        stage_doc = ROOT / str(manifest_stage["doc"])
        if not stage_doc.exists():
            _fail(f"{code_stage.id}学习文档不存在：{manifest_stage['doc']}")
        metadata = stage_metadata_pattern.search(stage_doc.read_text(encoding="utf-8"))
        if metadata is None:
            _fail(f"{code_stage.id}学习文档缺少机器可核对的阶段元数据")
        documented_nodes = [value.strip() for value in metadata.group("nodes").split(",")]
        if metadata.group("id") != code_stage.id or documented_nodes != list(code_stage.node_ids):
            _fail(f"{code_stage.id}学习文档元数据与代码事实不一致")

    workflow_fact_pattern = re.compile(
        r"<!-- workflow-fact: id=(?P<id>[^;]+); version=(?P<version>[^;]+); "
        r"nodes=(?P<nodes>\d+); edges=(?P<edges>\d+); learning_stages=(?P<stages>\d+) -->"
    )
    workflow_fact = workflow_fact_pattern.search(MAIN_WORKFLOW_DOC.read_text(encoding="utf-8"))
    if workflow_fact is None:
        _fail("39节点总览缺少机器可核对的Workflow事实元数据")
    expected_workflow_fact = {
        "id": CONTINUOUS_COLLABORATION_WORKFLOW.id,
        "version": CONTINUOUS_COLLABORATION_WORKFLOW.version,
        "nodes": str(len(CONTINUOUS_COLLABORATION_WORKFLOW.nodes)),
        "edges": str(len(CONTINUOUS_COLLABORATION_WORKFLOW.edges)),
        "stages": str(len(code_stages)),
    }
    if workflow_fact.groupdict() != expected_workflow_fact:
        _fail(f"39节点总览事实与代码不一致；文档={workflow_fact.groupdict()}；代码={expected_workflow_fact}")

    stale_current_patterns = {
        "把v1.4.0/28节点写成当前事实": r"当前[^\n]{0,80}v1\.4\.0[^\n]{0,40}28",
        "旧6阶段总览": r"总览图（6\s*阶段",
        "旧Executor数量": r"39\s*个节点其实只有约\s*20",
        "旧9决策节点口径": r"9\s*个决策节点",
        "把浅冻结说成每节点replace": r"每个节点用[^\n]{0,40}replace\(\)",
    }
    for path in sorted(MASTERY_ROOT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        for label, pattern in stale_current_patterns.items():
            if re.search(pattern, text):
                _fail(f"项目掌握仍含{label}：{path.relative_to(ROOT)}")
    for entry in manifest["quality_and_delivery_surfaces"]:
        if not (ROOT / str(entry["path"])).exists():
            _fail(f"工程/部署面不存在：{entry['path']}")

    print(
        "项目掌握覆盖校验通过："
        f"{len(units)}个学习单元，"
        f"{len(manifest['target_modules'])}个目标模块，"
        f"{len(manifest['backend_surfaces'])}个后端顶层源码面，"
        f"{len(manifest['frontend_feature_surfaces'])}个前端Feature面，"
        f"{len(manifest['frontend_root_surfaces'])}个前端根源码面，"
        f"{len(manifest['workflow_catalog'])}个Workflow，"
        f"{len(code_stages)}个主Workflow学习阶段，"
        f"{len(manifest['continuous_workflow_nodes'])}个主Workflow节点，"
        f"{len(manifest['runtime_roles'])}个运行/部署角色，"
        f"{len(manifest['protocol_boundaries'])}个协议边界，"
        f"{len(manifest['state_locations'])}个状态位置，"
        f"{scenario_count}个可执行调试场景。"
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Fail when project-mastery coverage drifts from top-level code or Workflow facts."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "项目掌握" / "coverage-manifest.json"
PROPOSAL = ROOT / "docs" / "overall-architecture-proposal.md"


def _fail(message: str) -> None:
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
        f"{len(manifest['continuous_workflow_nodes'])}个主Workflow节点，"
        f"{len(manifest['runtime_roles'])}个运行/部署角色，"
        f"{len(manifest['protocol_boundaries'])}个协议边界，"
        f"{len(manifest['state_locations'])}个状态位置。"
    )


if __name__ == "__main__":
    main()

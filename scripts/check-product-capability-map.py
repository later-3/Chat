#!/usr/bin/env python3
"""Fail when target capabilities drift away from owners, work packages or evidence."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Never
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "product-capability-manifest.json"
MAP_DOCUMENT = ROOT / "docs" / "product-capability-architecture-map.md"

ALLOWED_IMPLEMENTATION = {"implemented", "partial", "missing", "design_gap"}
ALLOWED_PACKAGE_STATUS = {"planned", "in_progress", "blocked", "completed"}
ALLOWED_MODULE_KINDS = {"state_owner", "application_component", "runtime_component"}
ALLOWED_CONTRACT_STATUS = {"implemented", "partial", "design_only", "missing"}
REQUIRED_DECISIONS = {"D1", "D2", "D3", "D4"}


def _fail(message: str) -> Never:
    raise SystemExit(f"ERROR: {message}")


def _unique_ids(label: str, values: list[dict[str, Any]]) -> set[str]:
    ids = [str(value.get("id") or "") for value in values]
    if any(not value for value in ids):
        _fail(f"{label}存在空ID")
    if len(ids) != len(set(ids)):
        _fail(f"{label}存在重复ID")
    return set(ids)


def _reference_path(reference: str) -> Path | None:
    target = reference.strip()
    if not target or target.startswith(("http://", "https://")):
        return None
    target = unquote(target.split("#", 1)[0])
    if not target or target.startswith("/"):
        return None
    return ROOT / target


def _check_reference(label: str, reference: str) -> None:
    path = _reference_path(reference)
    if path is not None and not path.exists():
        _fail(f"{label}引用不存在：{reference}")


def _check_references(label: str, values: list[str]) -> None:
    if not values:
        _fail(f"{label}没有权威或验收引用")
    for value in values:
        _check_reference(label, str(value))


def _check_dependency_graph(packages: dict[str, dict[str, Any]]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(package_id: str) -> None:
        if package_id in visiting:
            _fail(f"工作包依赖存在环：{package_id}")
        if package_id in visited:
            return
        visiting.add(package_id)
        for dependency in map(str, packages[package_id].get("depends_on", [])):
            if dependency not in packages:
                _fail(f"工作包{package_id}依赖未知工作包：{dependency}")
            visit(dependency)
        visiting.remove(package_id)
        visited.add(package_id)

    for package_id in packages:
        visit(package_id)


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != 1:
        _fail("product capability manifest schema_version必须为1")
    if manifest.get("status") not in {"candidate", "approved"}:
        _fail("product capability manifest使用未知状态")

    modules = manifest.get("modules")
    scenarios = manifest.get("scenarios")
    capabilities = manifest.get("capabilities")
    work_packages = manifest.get("work_packages")
    decisions = manifest.get("decisions")
    for label, values in (
        ("modules", modules),
        ("scenarios", scenarios),
        ("capabilities", capabilities),
        ("work_packages", work_packages),
        ("decisions", decisions),
    ):
        if not isinstance(values, list) or not values:
            _fail(f"{label}必须是非空列表")

    module_ids = _unique_ids("modules", modules)
    scenario_ids = _unique_ids("scenarios", scenarios)
    capability_ids = _unique_ids("capabilities", capabilities)
    package_ids = _unique_ids("work_packages", work_packages)
    decision_ids = _unique_ids("decisions", decisions)

    for module in modules:
        module_id = str(module["id"])
        if re.fullmatch(r"(?:MOD|APP|RT)-[A-Z]+", module_id) is None:
            _fail(f"模块ID格式无效：{module_id}")
        if module.get("kind") not in ALLOWED_MODULE_KINDS:
            _fail(f"模块{module_id}使用未知类型：{module.get('kind')}")
        if module.get("contract_status") not in ALLOWED_CONTRACT_STATUS:
            _fail(f"模块{module_id}使用未知公开合同状态：{module.get('contract_status')}")
        _check_reference(f"模块{module_id}公开合同", str(module.get("contract_ref") or ""))
        if manifest.get("status") == "approved" and str(module.get("decision") or "").startswith("pending_"):
            _fail(f"已批准Manifest仍把模块{module_id}标为待决策")

    for scenario in scenarios:
        scenario_id = str(scenario["id"])
        if re.fullmatch(r"SCN-\d{2}", scenario_id) is None:
            _fail(f"场景ID格式无效：{scenario_id}")
        _check_reference(f"场景{scenario_id}", str(scenario.get("authority_ref") or ""))

    gap_types = set(map(str, manifest.get("gap_types", [])))
    if not gap_types:
        _fail("gap_types不能为空")

    package_by_id = {str(value["id"]): value for value in work_packages}
    capability_to_packages: dict[str, set[str]] = {value: set() for value in capability_ids}
    for package in work_packages:
        package_id = str(package["id"])
        if re.fullmatch(r"W(?:10|[0-9])-\d{2}", package_id) is None:
            _fail(f"工作包ID格式无效：{package_id}")
        if str(package.get("workstream")) != package_id.split("-", 1)[0]:
            _fail(f"工作包{package_id}与workstream不一致")
        if package.get("status") not in ALLOWED_PACKAGE_STATUS:
            _fail(f"工作包{package_id}使用未知状态：{package.get('status')}")
        package_capabilities = set(map(str, package.get("capabilities", [])))
        unknown_capabilities = package_capabilities - capability_ids
        if unknown_capabilities:
            _fail(f"工作包{package_id}引用未知能力：{sorted(unknown_capabilities)}")
        if not package_capabilities:
            _fail(f"工作包{package_id}没有目标能力")
        for capability_id in package_capabilities:
            capability_to_packages[capability_id].add(package_id)
        _check_reference(f"工作包{package_id}设计门", str(package.get("design_gate") or ""))
        _check_references(
            f"工作包{package_id}验收",
            [str(value) for value in package.get("acceptance_refs", [])],
        )

    _check_dependency_graph(package_by_id)

    referenced_scenarios: set[str] = set()
    referenced_modules: set[str] = set()
    for capability in capabilities:
        capability_id = str(capability["id"])
        if re.fullmatch(r"CAP-\d{2}", capability_id) is None:
            _fail(f"能力ID格式无效：{capability_id}")
        owner = str(capability.get("owner") or "")
        if owner not in module_ids:
            _fail(f"能力{capability_id}没有有效唯一责任所有者：{owner}")
        referenced_modules.add(owner)
        supporting = set(map(str, capability.get("supporting", [])))
        unknown_modules = supporting - module_ids
        if unknown_modules:
            _fail(f"能力{capability_id}引用未知支持模块：{sorted(unknown_modules)}")
        referenced_modules.update(supporting)

        capability_scenarios = set(map(str, capability.get("scenarios", [])))
        unknown_scenarios = capability_scenarios - scenario_ids
        if unknown_scenarios:
            _fail(f"能力{capability_id}引用未知场景：{sorted(unknown_scenarios)}")
        if not capability_scenarios:
            _fail(f"能力{capability_id}没有代表场景")
        referenced_scenarios.update(capability_scenarios)

        implementation = str(capability.get("implementation") or "")
        if implementation not in ALLOWED_IMPLEMENTATION:
            _fail(f"能力{capability_id}使用未知实现状态：{implementation}")
        gaps = set(map(str, capability.get("gaps", [])))
        unknown_gaps = gaps - gap_types
        if unknown_gaps:
            _fail(f"能力{capability_id}引用未知差距类型：{sorted(unknown_gaps)}")
        if implementation != "implemented" and not gaps:
            _fail(f"未完成能力{capability_id}没有差距类型")
        if implementation != "implemented" and not capability_to_packages[capability_id]:
            _fail(f"未完成能力{capability_id}没有开发工作包")
        if implementation == "implemented" and not capability.get("evidence_refs"):
            _fail(f"已实现能力{capability_id}没有实现证据")
        _check_references(
            f"能力{capability_id}权威",
            [str(value) for value in capability.get("authority_refs", [])],
        )
        _check_references(
            f"能力{capability_id}当前证据",
            [str(value) for value in capability.get("evidence_refs", [])],
        )
        _check_references(
            f"能力{capability_id}验收",
            [str(value) for value in capability.get("acceptance_refs", [])],
        )

    if referenced_scenarios != scenario_ids:
        _fail(f"存在未被任何能力覆盖的场景：{sorted(scenario_ids - referenced_scenarios)}")
    if referenced_modules != module_ids:
        _fail(f"存在未被任何能力引用的模块/组件：{sorted(module_ids - referenced_modules)}")

    main_order = [str(value) for value in manifest.get("main_delivery_order", [])]
    active_packages = {
        package_id for package_id, package in package_by_id.items() if package.get("status") != "completed"
    }
    if len(main_order) != len(set(main_order)):
        _fail("main_delivery_order存在重复工作包")
    if set(main_order) != active_packages:
        _fail(
            "唯一主顺序与未完成工作包不一致；"
            f"漏项={sorted(active_packages - set(main_order))}；失效={sorted(set(main_order) - active_packages)}"
        )
    order_index = {package_id: index for index, package_id in enumerate(main_order)}
    for package_id in main_order:
        for dependency in map(str, package_by_id[package_id].get("depends_on", [])):
            if package_by_id[dependency].get("status") == "completed":
                continue
            if order_index[dependency] >= order_index[package_id]:
                _fail(f"唯一主顺序把依赖{dependency}排在{package_id}之后")

    if decision_ids != REQUIRED_DECISIONS:
        _fail(f"D1-D4决策卡不完整：{sorted(REQUIRED_DECISIONS - decision_ids)}")
    for decision in decisions:
        decision_id = str(decision["id"])
        if decision.get("status") not in {"pending_user_review", "approved", "rejected"}:
            _fail(f"决策{decision_id}使用未知状态：{decision.get('status')}")
        if manifest.get("status") == "approved" and decision.get("status") != "approved":
            _fail(f"已批准Manifest中的决策{decision_id}不是approved")
        _check_reference(f"决策{decision_id}", str(decision.get("doc_ref") or ""))

    map_text = MAP_DOCUMENT.read_text(encoding="utf-8")
    for capability_id in capability_ids:
        if capability_id not in map_text:
            _fail(f"人读开发地图缺少能力：{capability_id}")
    for decision_id in REQUIRED_DECISIONS:
        heading_pattern = rf"^## (?:\d+\.\s+)?{re.escape(decision_id)}："
        if re.search(heading_pattern, map_text, flags=re.MULTILINE) is None:
            _fail(f"人读开发地图缺少完整决策卡：{decision_id}")

    for required_document in ("README.md", "PROJECT_PLAN.md", "docs/overall-architecture-proposal.md"):
        text = (ROOT / required_document).read_text(encoding="utf-8")
        if "product-capability-architecture-map" not in text:
            _fail(f"{required_document}没有链接目标能力开发地图")

    print(
        "product capability map ok: "
        f"{len(scenario_ids)} scenarios, {len(capability_ids)} capabilities, "
        f"{len(module_ids)} modules/components, {len(package_ids)} work packages, "
        f"{len(decision_ids)} decisions"
    )


if __name__ == "__main__":
    main()

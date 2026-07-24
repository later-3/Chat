#!/usr/bin/env python3
"""Validate current project documentation without reading private runtime config."""

from __future__ import annotations

import importlib.metadata
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

PROJECT_ROOT = Path(__file__).resolve().parents[1]
IGNORED_PARTS = {".git", ".venv", "node_modules", ".test-artifacts", ".artifacts"}
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")

REQUIRED_FILES = (
    "docs/adr/0001-application-composition-and-process-entrypoints.md",
    "docs/adr/0002-observability-and-sensitive-data-boundary.md",
    "docs/dependency-upgrade-runbook.md",
    "docs/quality-gates.md",
)
PYTHON_LOCKED_VERSIONS = {
    "agent-framework-core": "1.11.0",
    "agent-framework-openai": "1.10.1",
    "agent-framework-ag-ui": "1.0.0rc8",
}
FRONTEND_LOCKED_VERSIONS = {
    "@ag-ui/client": "0.0.57",
    "@ag-ui/core": "0.0.57",
    "@playwright/test": "1.61.1",
}
STALE_CURRENT_FACTS = (
    "当前没有CI、Python Lint/严格静态类型、覆盖率、前端Lint/组件测试、自动浏览器E2E",
    "没有统一错误Envelope、请求关联",
    "没有统一结构化配置、全链路关联、Metrics、Readiness",
)


def markdown_files() -> list[Path]:
    return [
        value
        for value in PROJECT_ROOT.rglob("*.md")
        if not any(part in IGNORED_PARTS for part in value.relative_to(PROJECT_ROOT).parts)
    ]


def local_link_target(document: Path, raw_target: str) -> Path | None:
    target = raw_target.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    if not target or target.startswith(("#", "http://", "https://", "mailto:", "app://")):
        return None
    target = unquote(target.split("#", 1)[0])
    if not target or target.startswith("/"):
        # Absolute developer-machine evidence paths are intentionally not CI contracts.
        return None
    return (document.parent / target).resolve()


def check_links(errors: list[str]) -> int:
    count = 0
    for document in markdown_files():
        text = document.read_text(encoding="utf-8")
        for match in LINK_PATTERN.finditer(text):
            target = local_link_target(document, match.group(1))
            if target is None:
                continue
            count += 1
            try:
                target.relative_to(PROJECT_ROOT)
            except ValueError:
                errors.append(f"{document.relative_to(PROJECT_ROOT)}: 链接越出仓库 {match.group(1)}")
                continue
            if not target.exists():
                errors.append(f"{document.relative_to(PROJECT_ROOT)}: 失效链接 {match.group(1)}")
    return count


def check_versions(errors: list[str]) -> None:
    state = (PROJECT_ROOT / "PROJECT_STATE.md").read_text(encoding="utf-8")
    for package, expected in PYTHON_LOCKED_VERSIONS.items():
        actual = importlib.metadata.version(package)
        if actual != expected:
            errors.append(f"{package}: 虚拟环境={actual}，治理基线={expected}")
        if f"`{package} {expected}`" not in state:
            errors.append(f"PROJECT_STATE.md未记录当前{package} {expected}")

    package_json = json.loads((PROJECT_ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((PROJECT_ROOT / "frontend/package-lock.json").read_text(encoding="utf-8"))
    root_lock = package_lock["packages"][""]
    for package, expected in FRONTEND_LOCKED_VERSIONS.items():
        declared = package_json.get("dependencies", {}).get(package) or package_json.get(
            "devDependencies", {}
        ).get(package)
        locked = root_lock.get("dependencies", {}).get(package) or root_lock.get(
            "devDependencies", {}
        ).get(package)
        if declared != expected or locked != expected:
            errors.append(
                f"{package}: package.json={declared!r}，package-lock根={locked!r}，治理基线={expected}"
            )


def check_current_facts(errors: list[str]) -> None:
    state = (PROJECT_ROOT / "PROJECT_STATE.md").read_text(encoding="utf-8")
    for stale in STALE_CURRENT_FACTS:
        if stale in state:
            errors.append(f"PROJECT_STATE.md仍包含已失效事实: {stale}")

    readme = (PROJECT_ROOT / "README.md").read_text(encoding="utf-8")
    for required in ("./scripts/verify-fast.sh", "./scripts/verify.sh", "./scripts/verify-fault-lab.sh"):
        if required not in readme:
            errors.append(f"README.md缺少验证入口 {required}")
    if "backend.app.main:app" in readme:
        errors.append("README.md仍使用会在导入时装配私有配置的旧ASGI入口")

    for relative in REQUIRED_FILES:
        if not (PROJECT_ROOT / relative).is_file():
            errors.append(f"缺少Q07治理文档 {relative}")


def main() -> int:
    errors: list[str] = []
    link_count = check_links(errors)
    check_versions(errors)
    check_current_facts(errors)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"project docs ok: {len(markdown_files())} files, {link_count} local links")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

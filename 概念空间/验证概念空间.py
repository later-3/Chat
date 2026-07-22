#!/usr/bin/env python3
"""Validate the structure, semantics, registration and links of Chat concepts."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SPACE = ROOT / "概念空间"

REQUIRED_FILES = (
    ROOT / "概念空间.md",
    SPACE / "AGENTS.md",
    SPACE / "00-索引.md",
    SPACE / "Chat" / "00-索引.md",
)

REQUIRED_SEMANTICS = {
    "文档治理信息": ("文档治理信息",),
    "一句话理解": ("一句话理解",),
    "为什么需要": ("为什么需要", "解决的问题"),
    "定义": ("定义",),
    "边界": ("边界", "不是什么"),
    "关系": ("关系",),
    "使用": ("怎样使用", "如何使用"),
    "正例与反例": ("正例与反例",),
    "状态与未知": ("当前状态与未知", "状态与未知"),
    "来源": ("来源", "依据"),
    "维护": ("维护", "重入"),
    "验证": ("验证",),
}

ALLOWED_STATES = ("候选", "有效", "修订中", "已停用")
LINK_RE = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)


def markdown_files() -> list[Path]:
    return sorted(SPACE.rglob("*.md"))


def concept_files() -> list[Path]:
    return [
        path
        for path in markdown_files()
        if path.name not in {"AGENTS.md", "00-索引.md"}
    ]


def local_link_target(source: Path, raw_target: str) -> Path | None:
    target = raw_target.strip().strip("<>")
    if not target or target.startswith(("#", "http://", "https://", "mailto:")):
        return None
    target = unquote(target.split("#", 1)[0])
    if not target:
        return None
    candidate = Path(target)
    if not candidate.is_absolute():
        candidate = source.parent / candidate
    return candidate.resolve()


def check_links(path: Path, errors: list[str]) -> int:
    text = path.read_text(encoding="utf-8")
    checked = 0
    for raw_target in LINK_RE.findall(text):
        target = local_link_target(path, raw_target)
        if target is None:
            continue
        checked += 1
        if not target.exists():
            errors.append(f"断链：{path.relative_to(ROOT)} -> {raw_target}")
    return checked


def check_concept(path: Path, global_index: str, errors: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    headings = "\n".join(HEADING_RE.findall(text))

    for semantic, alternatives in REQUIRED_SEMANTICS.items():
        if not any(term in headings for term in alternatives):
            errors.append(
                f"概念语义缺失：{path.relative_to(ROOT)} 没有可发现的“{semantic}”章节"
            )

    if not any(state in text for state in ALLOWED_STATES):
        errors.append(
            f"概念状态缺失：{path.relative_to(ROOT)} 未使用候选/有效/修订中/已停用"
        )
    if "实现状态" not in text:
        errors.append(
            f"实现状态缺失：{path.relative_to(ROOT)} 未区分概念状态与实现状态"
        )

    relative_from_space = path.relative_to(SPACE).as_posix()
    if relative_from_space not in global_index:
        errors.append(f"总索引未登记：{path.relative_to(ROOT)}")

    scope_index_path = path.parent / "00-索引.md"
    if not scope_index_path.exists():
        errors.append(f"作用域索引缺失：{scope_index_path.relative_to(ROOT)}")
        return
    scope_index = scope_index_path.read_text(encoding="utf-8")
    if path.name not in scope_index:
        errors.append(f"作用域索引未登记：{path.relative_to(ROOT)}")


def main() -> int:
    errors: list[str] = []
    for path in REQUIRED_FILES:
        if not path.exists():
            errors.append(f"必需文件缺失：{path.relative_to(ROOT)}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    root_meta = (ROOT / "概念空间.md").read_text(encoding="utf-8")
    if "概念空间/00-索引.md" not in root_meta:
        errors.append("根概念空间没有指向具体概念资产索引")

    global_index = (SPACE / "00-索引.md").read_text(encoding="utf-8")
    files = markdown_files()
    concepts = concept_files()
    if not concepts:
        errors.append("概念资产目录中没有具体概念正文")

    for path in concepts:
        check_concept(path, global_index, errors)

    link_count = 0
    for path in [ROOT / "概念空间.md", *files]:
        link_count += check_links(path, errors)

    empty_dirs = [
        path
        for path in sorted(SPACE.rglob("*"))
        if path.is_dir() and not any(path.iterdir())
    ]
    for path in empty_dirs:
        errors.append(f"空作用域目录：{path.relative_to(ROOT)}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        print(
            f"概念空间校验失败：{len(concepts)} 个概念簇，"
            f"{link_count} 个本地链接，{len(errors)} 个错误"
        )
        return 1

    print(
        f"概念空间校验通过：{len(concepts)} 个概念簇，"
        f"{len(files)} 个目录文档，{link_count} 个本地链接"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

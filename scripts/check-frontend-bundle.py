#!/usr/bin/env python3
"""Fail the production gate when the frontend loses its feature chunk boundaries."""

from __future__ import annotations

import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
MANIFEST_PATH = FRONTEND_DIST / ".vite" / "manifest.json"

# These are regression budgets, not performance targets. Lowering them requires
# measured UX evidence; raising them requires a reviewed explanation.
ENTRY_JS_LIMIT = 500 * 1024
CSS_LIMIT = 150 * 1024
FEATURE_CHUNK_LIMIT = 150 * 1024
MIN_DYNAMIC_FEATURES = 8


def _size(relative_path: str) -> int:
    path = FRONTEND_DIST / relative_path
    if not path.is_file():
        raise AssertionError(f"构建清单引用了不存在的文件: {relative_path}")
    return path.stat().st_size


def main() -> None:
    if not MANIFEST_PATH.is_file():
        raise AssertionError("缺少Vite manifest；请先运行frontend生产构建")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    entries = [value for value in manifest.values() if value.get("isEntry")]
    if len(entries) != 1:
        raise AssertionError(f"预期1个前端入口，实际为{len(entries)}")

    entry = entries[0]
    entry_size = _size(entry["file"])
    if entry_size > ENTRY_JS_LIMIT:
        raise AssertionError(
            f"主入口{entry_size / 1024:.1f} KiB超过{ENTRY_JS_LIMIT / 1024:.0f} KiB预算"
        )

    css_files = [value for item in manifest.values() for value in item.get("css", ())]
    for css_file in set(css_files):
        css_size = _size(css_file)
        if css_size > CSS_LIMIT:
            raise AssertionError(
                f"样式包{css_file}为{css_size / 1024:.1f} KiB，"
                f"超过{CSS_LIMIT / 1024:.0f} KiB预算"
            )

    dynamic_entries = [value for value in manifest.values() if value.get("isDynamicEntry")]
    if len(dynamic_entries) < MIN_DYNAMIC_FEATURES:
        raise AssertionError(
            f"只有{len(dynamic_entries)}个按需Feature，至少需要{MIN_DYNAMIC_FEATURES}个"
        )
    oversized = [
        (value["file"], _size(value["file"]))
        for value in dynamic_entries
        if _size(value["file"]) > FEATURE_CHUNK_LIMIT
    ]
    if oversized:
        details = ", ".join(f"{name}={size / 1024:.1f} KiB" for name, size in oversized)
        raise AssertionError(f"Feature Chunk超过预算: {details}")

    print(
        "Frontend bundle gate passed: "
        f"entry={entry_size / 1024:.1f} KiB, "
        f"dynamic_features={len(dynamic_entries)}, css_files={len(set(css_files))}"
    )


if __name__ == "__main__":
    main()

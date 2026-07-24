"""Safe, paginated directory browsing under the Workspace Root Catalog."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

from .catalog import WorkspaceRootCatalog
from .contracts import ProjectResourceValidationError
from .pagination import decode_cursor, encode_cursor
from .paths import normalize_relative_path, resolve_repository_path


def _is_reparse_point(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _git_marker(directory: Path) -> bool:
    try:
        metadata = (directory / ".git").lstat()
    except OSError:
        return False
    return not stat.S_ISLNK(metadata.st_mode) and not _is_reparse_point(metadata)


class WorkspaceDirectoryBrowser:
    """Enumerate visible directories without returning or following real paths."""

    def __init__(self, catalog: WorkspaceRootCatalog) -> None:
        self._catalog = catalog

    def list_directories(
        self,
        *,
        root_key: str,
        relative_path: str = ".",
        cursor: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        if not 1 <= limit <= 100:
            raise ProjectResourceValidationError(
                "目录分页limit必须在1到100之间",
                code="REPOSITORY_PAGE_LIMIT_INVALID",
            )
        normalized = normalize_relative_path(relative_path)
        safe = resolve_repository_path(
            self._catalog.require_available(root_key),
            normalized,
        )
        cursor_payload = decode_cursor(cursor, kind="repository-directory")
        after = ""
        if cursor_payload is not None:
            if (
                cursor_payload.get("root_key") != root_key
                or cursor_payload.get("relative_path") != normalized
                or not isinstance(cursor_payload.get("after"), str)
            ):
                raise ProjectResourceValidationError(
                    "Repository目录游标与当前路径不匹配",
                    code="REPOSITORY_CURSOR_INVALID",
                )
            after = cursor_payload["after"]

        entries: list[dict[str, Any]] = []
        try:
            candidates = sorted(
                safe.absolute_path.iterdir(),
                key=lambda value: value.name,
            )
        except OSError as error:
            raise ProjectResourceValidationError(
                "Repository目录不可读取",
                code="REPOSITORY_PATH_UNREADABLE",
            ) from error
        for candidate in candidates:
            name = candidate.name
            if name.startswith(".") or name <= after:
                continue
            try:
                name.encode("utf-8", errors="strict")
                metadata = candidate.lstat()
            except (OSError, UnicodeError):
                continue
            if (
                not stat.S_ISDIR(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or _is_reparse_point(metadata)
            ):
                continue
            child_relative = name if normalized == "." else f"{normalized}/{name}"
            entries.append(
                {
                    "name": name,
                    "relative_path": child_relative,
                    "has_git_marker": _git_marker(candidate),
                    "selectable": True,
                }
            )
            if len(entries) > limit:
                break

        page = entries[:limit]
        next_cursor = None
        if len(entries) > limit and page:
            next_cursor = encode_cursor(
                {
                    "kind": "repository-directory",
                    "root_key": root_key,
                    "relative_path": normalized,
                    "after": page[-1]["name"],
                }
            )
        parent = None
        if normalized != ".":
            segments = normalized.split("/")
            parent = "/".join(segments[:-1]) or "."
        return {
            "root_key": root_key,
            "relative_path": normalized,
            "parent_relative_path": parent,
            "current_has_git_marker": _git_marker(safe.absolute_path),
            "directories": page,
            "next_cursor": next_cursor,
        }

"""Fail-closed path normalization and containment for repository inspection."""

from __future__ import annotations

import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from .catalog import WorkspaceRoot, root_identity_hash
from .contracts import ProjectResourceValidationError, locator_hash

WINDOWS_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:")


@dataclass(frozen=True, slots=True)
class SafeRepositoryPath:
    """Resolved adapter input; ``absolute_path`` must never enter a projection."""

    root_key: str
    relative_path: str
    absolute_path: Path
    root_identity_hash: str
    locator_hash: str


def _is_reparse_point(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def normalize_relative_path(value: str | None) -> str:
    """Normalize the client locator while rejecting traversal ambiguities."""

    raw = (value or "").strip()
    if raw in {"", "."}:
        return "."
    if "\x00" in raw:
        raise ProjectResourceValidationError(
            "Repository相对路径包含NUL",
            code="REPOSITORY_PATH_INVALID",
        )
    normalized = raw.replace("\\", "/")
    if normalized.startswith("/") or WINDOWS_DRIVE_PATTERN.match(normalized):
        raise ProjectResourceValidationError(
            "Repository路径必须相对于Workspace Root",
            code="REPOSITORY_PATH_INVALID",
        )
    segments = normalized.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ProjectResourceValidationError(
            "Repository相对路径包含空段或路径穿越",
            code="REPOSITORY_PATH_INVALID",
        )
    return "/".join(segments)


def resolve_repository_path(root: WorkspaceRoot, relative_path: str | None) -> SafeRepositoryPath:
    """Resolve every segment with ``lstat`` and reject all link traversal."""

    if not root.available or root.resolved_root is None or root.identity_hash is None:
        raise ProjectResourceValidationError(
            "Workspace Root当前不可用",
            code=root.error_code or "REPOSITORY_ROOT_UNAVAILABLE",
        )
    normalized = normalize_relative_path(relative_path)
    try:
        root_metadata = root.configured_path.lstat()
    except OSError as error:
        raise ProjectResourceValidationError(
            "Workspace Root当前不可用",
            code="REPOSITORY_ROOT_UNAVAILABLE",
        ) from error
    if stat.S_ISLNK(root_metadata.st_mode) or _is_reparse_point(root_metadata):
        raise ProjectResourceValidationError(
            "Workspace Root不能是符号链接",
            code="REPOSITORY_SYMLINK_REJECTED",
        )
    try:
        current_root = root.configured_path.resolve(strict=True)
    except OSError as error:
        raise ProjectResourceValidationError(
            "Workspace Root无法安全解析",
            code="REPOSITORY_ROOT_UNAVAILABLE",
        ) from error
    if current_root != root.resolved_root or root_identity_hash(current_root) != root.identity_hash:
        raise ProjectResourceValidationError(
            "Workspace Root身份已变化，需要重新配置",
            code="REPOSITORY_ROOT_IDENTITY_CHANGED",
        )

    current = current_root
    if normalized != ".":
        for segment in normalized.split("/"):
            current = current / segment
            try:
                metadata = current.lstat()
            except FileNotFoundError as error:
                raise ProjectResourceValidationError(
                    "Repository目录不存在",
                    code="REPOSITORY_NOT_FOUND",
                ) from error
            except OSError as error:
                raise ProjectResourceValidationError(
                    "Repository目录不可读取",
                    code="REPOSITORY_PATH_UNREADABLE",
                ) from error
            if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata):
                raise ProjectResourceValidationError(
                    "Repository路径不能经过符号链接",
                    code="REPOSITORY_SYMLINK_REJECTED",
                )
    try:
        resolved = current.resolve(strict=True)
    except OSError as error:
        raise ProjectResourceValidationError(
            "Repository目录无法安全解析",
            code="REPOSITORY_PATH_UNREADABLE",
        ) from error
    if resolved != current_root and not resolved.is_relative_to(current_root):
        raise ProjectResourceValidationError(
            "Repository路径越过Workspace Root",
            code="REPOSITORY_PATH_OUTSIDE_ROOT",
        )
    if not resolved.is_dir():
        raise ProjectResourceValidationError(
            "Repository绑定目标必须是目录",
            code="REPOSITORY_NOT_DIRECTORY",
        )
    return SafeRepositoryPath(
        root_key=root.key,
        relative_path=normalized,
        absolute_path=resolved,
        root_identity_hash=root.identity_hash,
        locator_hash=locator_hash(
            root_identity_hash=root.identity_hash,
            relative_path=normalized,
        ),
    )

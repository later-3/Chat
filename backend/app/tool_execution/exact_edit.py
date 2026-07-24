"""Pure validation and filesystem policy for the SD3 exact-edit capability."""

from __future__ import annotations

import difflib
import fnmatch
import hashlib
import os
import stat
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .contracts import (
    MAX_DIFF_PREVIEW_CHARS,
    MAX_EDIT_FILE_BYTES,
    MAX_EDIT_TEXT_CHARS,
    PROTECTED_WRITE_PATTERNS,
    ToolOperationError,
)


def normalize_arguments(arguments: Mapping[str, Any]) -> dict[str, str]:
    """Validate and canonicalize one exact-edit request before persistence."""

    if set(arguments) != {"path", "old_text", "new_text"}:
        raise ToolOperationError(
            "edit只接受path、old_text和new_text",
            code="TOOL_OPERATION_ARGUMENT_INVALID",
        )
    raw_path = arguments.get("path")
    old_text = arguments.get("old_text")
    new_text = arguments.get("new_text")
    if not isinstance(raw_path, str) or not isinstance(old_text, str) or not isinstance(new_text, str):
        raise ToolOperationError(
            "edit参数必须是字符串",
            code="TOOL_OPERATION_ARGUMENT_INVALID",
        )
    path = raw_path.strip().replace("\\", "/")
    segments = path.split("/")
    if (
        not path
        or path.startswith("/")
        or "\x00" in path
        or any(segment in {"", ".", ".."} for segment in segments)
        or len(path) > 512
    ):
        raise ToolOperationError(
            "edit路径必须是Workspace内规范相对路径",
            code="TOOL_OPERATION_PATH_INVALID",
        )
    if not old_text or old_text == new_text:
        raise ToolOperationError(
            "edit必须提供非空且不同的old_text/new_text",
            code="TOOL_OPERATION_ARGUMENT_INVALID",
        )
    if len(old_text) > MAX_EDIT_TEXT_CHARS or len(new_text) > MAX_EDIT_TEXT_CHARS:
        raise ToolOperationError(
            "edit文本超过本阶段上限",
            code="TOOL_OPERATION_ARGUMENT_TOO_LARGE",
        )
    name = Path(path).name
    if any(
        fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(name, pattern)
        for pattern in PROTECTED_WRITE_PATTERNS
    ):
        raise ToolOperationError(
            "edit目标受Protected Source Policy保护",
            code="TOOL_OPERATION_SOURCE_PROTECTED",
        )
    return {"path": path, "old_text": old_text, "new_text": new_text}


def resolve_target(root: Path, relative: str, *, require_existing: bool = True) -> Path:
    """Resolve a repository-relative path without following symlink segments."""

    current = root
    for segment in relative.split("/"):
        current = current / segment
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if require_existing:
                raise ToolOperationError(
                    "edit目标不存在",
                    code="TOOL_OPERATION_TARGET_NOT_FOUND",
                ) from None
            break
        except OSError as error:
            raise ToolOperationError(
                "edit目标不可访问",
                code="TOOL_OPERATION_TARGET_UNAVAILABLE",
            ) from error
        reparse = bool(
            getattr(metadata, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        )
        if stat.S_ISLNK(metadata.st_mode) or reparse:
            raise ToolOperationError(
                "edit路径不能经过符号链接",
                code="TOOL_OPERATION_SYMLINK_REJECTED",
            )
    resolved = current.resolve(strict=False)
    if resolved != root and not resolved.is_relative_to(root):
        raise ToolOperationError(
            "edit路径越过Execution Workspace",
            code="TOOL_OPERATION_PATH_ESCAPE",
        )
    return resolved


def read_utf8(target: Path) -> str:
    """Read one bounded regular UTF-8 file."""

    try:
        metadata = target.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ToolOperationError(
                "edit目标必须是普通文件",
                code="TOOL_OPERATION_EXPECTED_FILE",
            )
        if metadata.st_size > MAX_EDIT_FILE_BYTES:
            raise ToolOperationError(
                "edit目标超过本阶段文件大小上限",
                code="TOOL_OPERATION_FILE_TOO_LARGE",
            )
        raw = target.read_bytes()
        if b"\x00" in raw:
            raise UnicodeDecodeError("utf-8", raw, 0, 1, "binary")
        return raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ToolOperationError(
            "edit目标必须是UTF-8文本文件",
            code="TOOL_OPERATION_FILE_NOT_UTF8",
        ) from error
    except OSError as error:
        raise ToolOperationError(
            "edit目标不可读取",
            code="TOOL_OPERATION_TARGET_UNAVAILABLE",
        ) from error


def apply_exact_edit(
    target: Path,
    arguments: Mapping[str, str],
    expected_preimage_hash: str,
    expected_postimage_hash: str,
) -> None:
    """Atomically replace one verified preimage with its deterministic postimage."""

    preimage = read_utf8(target)
    if text_hash(preimage) != expected_preimage_hash:
        raise ToolOperationError(
            "edit目标自批准后已经变化",
            code="TOOL_OPERATION_PREIMAGE_STALE",
        )
    if preimage.count(arguments["old_text"]) != 1:
        raise ToolOperationError(
            "edit匹配在执行前已经变化",
            code="TOOL_OPERATION_PREIMAGE_STALE",
        )
    postimage = preimage.replace(arguments["old_text"], arguments["new_text"], 1)
    if text_hash(postimage) != expected_postimage_hash:
        raise ToolOperationError(
            "edit确定性Postimage校验失败",
            code="TOOL_OPERATION_POSTIMAGE_MISMATCH",
        )
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{target.name}.chat-edit-",
            dir=target.parent,
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(postimage.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, stat.S_IMODE(target.stat().st_mode))
        os.replace(temporary_path, target)
        directory_fd = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def safe_file_hash(target: Path) -> str | None:
    """Return a file hash for reconciliation without turning absence into success."""

    try:
        if not target.is_file() or target.is_symlink():
            return None
        return hashlib.sha256(target.read_bytes()).hexdigest()
    except OSError:
        return None


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def diff_preview(path: str, before: str, after: str) -> str:
    value = "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )
    if len(value) <= MAX_DIFF_PREVIEW_CHARS:
        return value
    return value[:MAX_DIFF_PREVIEW_CHARS] + "\n… diff preview truncated …\n"

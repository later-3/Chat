"""Bounded repository read tools used by the governed pi adapter.

These implementations do not delegate to pi built-ins or shell commands.  Each
call revalidates the immutable RepositoryFence, resolves path containment, and
returns a bounded public result suitable for the Runtime Journal.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import stat
from copy import deepcopy
from pathlib import Path
from typing import Any, Mapping

from ..execution_dispatch.contracts import RepositoryFence
from ..execution_dispatch.repository_context import RepositoryExecutionContextService

MAX_TOOL_RESULT_BYTES = 64 * 1024
MAX_READ_BYTES = 64 * 1024
MAX_READ_LINES = 2_000
MAX_RESULT_ITEMS = 500
MAX_SCAN_FILES = 5_000
MAX_SCAN_BYTES = 16 * 1024 * 1024
PROTECTED_SOURCE_PATTERNS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".pypirc",
    "credentials*.json",
    "backend/config.json",
)


class ReadonlyToolValidationError(ValueError):
    """A safe, stable read-tool failure."""

    def __init__(self, message: str, *, code: str) -> None:
        self.code = code
        super().__init__(message)


def _is_reparse_point(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _positive_int(value: Any, *, default: int, maximum: int, field: str) -> int:
    if value is None:
        return default
    if isinstance(value, bool):
        raise ReadonlyToolValidationError(
            f"{field}必须是正整数",
            code="READ_TOOL_ARGUMENT_INVALID",
        )
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise ReadonlyToolValidationError(
            f"{field}必须是正整数",
            code="READ_TOOL_ARGUMENT_INVALID",
        ) from error
    if result < 1 or result > maximum:
        raise ReadonlyToolValidationError(
            f"{field}必须在1到{maximum}之间",
            code="READ_TOOL_ARGUMENT_INVALID",
        )
    return result


def _relative_path(value: Any) -> str:
    raw = str(value or ".").strip().replace("\\", "/")
    if raw in {"", "."}:
        return "."
    if raw.startswith("/") or "\x00" in raw:
        raise ReadonlyToolValidationError(
            "Tool路径必须是Repository内相对路径",
            code="READ_TOOL_PATH_INVALID",
        )
    segments = raw.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ReadonlyToolValidationError(
            "Tool路径包含空段或路径穿越",
            code="READ_TOOL_PATH_INVALID",
        )
    return "/".join(segments)


def _is_protected_source(relative_path: str) -> bool:
    normalized = relative_path.removeprefix("./")
    name = Path(normalized).name
    return any(
        fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(name, pattern)
        for pattern in PROTECTED_SOURCE_PATTERNS
    )


def _assert_source_allowed(relative_path: str) -> None:
    if _is_protected_source(relative_path):
        raise ReadonlyToolValidationError(
            "Tool目标受Protected Source Policy保护",
            code="READ_TOOL_SOURCE_PROTECTED",
        )


def _bounded_result(value: Mapping[str, Any]) -> dict[str, Any]:
    """Bound the serialized public/tool result without changing its schema."""

    result = deepcopy(dict(value))
    candidate = result.get("result")
    if not isinstance(candidate, dict):
        return result
    list_key = next(
        (key for key in ("lines", "matches", "entries") if isinstance(candidate.get(key), list)),
        None,
    )
    while len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()) > MAX_TOOL_RESULT_BYTES:
        if list_key is None or not candidate[list_key]:
            raise ReadonlyToolValidationError(
                "Tool结果超过公开上限",
                code="READ_TOOL_RESULT_TOO_LARGE",
            )
        items = candidate[list_key]
        last = items[-1]
        if (
            list_key == "lines"
            and len(items) == 1
            and isinstance(last, dict)
            and isinstance(last.get("text"), str)
            and last["text"]
        ):
            last["text"] = last["text"][: max(0, len(last["text"]) // 2)]
        else:
            items.pop()
        candidate["truncated"] = True
    return result


def _resolve_entry(root: Path, relative_path: str) -> Path:
    current = root
    if relative_path == ".":
        return current
    for segment in relative_path.split("/"):
        current = current / segment
        try:
            metadata = current.lstat()
        except FileNotFoundError as error:
            raise ReadonlyToolValidationError(
                "Tool目标不存在",
                code="READ_TOOL_TARGET_NOT_FOUND",
            ) from error
        except OSError as error:
            raise ReadonlyToolValidationError(
                "Tool目标不可读取",
                code="READ_TOOL_TARGET_UNREADABLE",
            ) from error
        if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata):
            raise ReadonlyToolValidationError(
                "Tool路径不能经过符号链接",
                code="READ_TOOL_SYMLINK_REJECTED",
            )
    try:
        resolved = current.resolve(strict=True)
    except OSError as error:
        raise ReadonlyToolValidationError(
            "Tool目标无法安全解析",
            code="READ_TOOL_TARGET_UNREADABLE",
        ) from error
    if resolved != root and not resolved.is_relative_to(root):
        raise ReadonlyToolValidationError(
            "Tool路径越过Repository边界",
            code="READ_TOOL_PATH_OUTSIDE_REPOSITORY",
        )
    return resolved


def _visible_tree(root: Path):
    """Yield safe non-symlink entries without following hidden VCS internals."""

    yielded = 0
    for current, directories, files in os.walk(root, followlinks=False):
        base = Path(current)
        safe_directories: list[str] = []
        for name in sorted(directories):
            if name == ".git":
                continue
            candidate = base / name
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata):
                continue
            safe_directories.append(name)
        directories[:] = safe_directories
        for name in sorted(files):
            candidate = base / name
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if (
                not stat.S_ISREG(metadata.st_mode)
                or stat.S_ISLNK(metadata.st_mode)
                or _is_reparse_point(metadata)
                or _is_protected_source(candidate.relative_to(root).as_posix())
            ):
                continue
            yielded += 1
            if yielded > MAX_SCAN_FILES:
                return
            yield candidate


class ReadonlyToolService:
    """Execute the exact allowlisted read-only tool set."""

    allowed_tools = frozenset({"read", "grep", "find", "ls"})

    def __init__(
        self,
        repository_context: RepositoryExecutionContextService,
    ) -> None:
        self._repository_context = repository_context

    async def execute(
        self,
        *,
        fence: RepositoryFence,
        tool_name: str,
        arguments: Mapping[str, Any],
    ) -> dict[str, Any]:
        if tool_name not in self.allowed_tools:
            raise ReadonlyToolValidationError(
                "Tool不在pi只读Capability Allowlist",
                code="READ_TOOL_NOT_ALLOWED",
            )
        root = await self._repository_context.resolve_private_path(fence)
        if tool_name == "read":
            result = self._read(root, arguments)
        elif tool_name == "grep":
            result = self._grep(root, arguments)
        elif tool_name == "find":
            result = self._find(root, arguments)
        else:
            result = self._ls(root, arguments)
        return _bounded_result(
            {
                "tool": tool_name,
                "repository_snapshot_id": fence.snapshot_id,
                "result": result,
            }
        )

    @staticmethod
    def _read(root: Path, arguments: Mapping[str, Any]) -> dict[str, Any]:
        relative = _relative_path(arguments.get("path"))
        _assert_source_allowed(relative)
        target = _resolve_entry(root, relative)
        if not target.is_file():
            raise ReadonlyToolValidationError(
                "read目标必须是普通文件",
                code="READ_TOOL_EXPECTED_FILE",
            )
        offset = _positive_int(
            arguments.get("offset"),
            default=1,
            maximum=10_000_000,
            field="offset",
        )
        limit = _positive_int(
            arguments.get("limit"),
            default=200,
            maximum=MAX_READ_LINES,
            field="limit",
        )
        try:
            raw = target.read_bytes()[: MAX_READ_BYTES + 1]
        except OSError as error:
            raise ReadonlyToolValidationError(
                "read目标不可读取",
                code="READ_TOOL_TARGET_UNREADABLE",
            ) from error
        truncated_bytes = len(raw) > MAX_READ_BYTES
        text = raw[:MAX_READ_BYTES].decode("utf-8", errors="replace")
        lines = text.splitlines()
        selected = lines[offset - 1 : offset - 1 + limit]
        return {
            "path": relative,
            "offset": offset,
            "lines": [{"line": offset + index, "text": value} for index, value in enumerate(selected)],
            "truncated": truncated_bytes or offset - 1 + limit < len(lines),
        }

    @staticmethod
    def _ls(root: Path, arguments: Mapping[str, Any]) -> dict[str, Any]:
        relative = _relative_path(arguments.get("path"))
        target = _resolve_entry(root, relative)
        if not target.is_dir():
            raise ReadonlyToolValidationError(
                "ls目标必须是目录",
                code="READ_TOOL_EXPECTED_DIRECTORY",
            )
        limit = _positive_int(
            arguments.get("limit"),
            default=200,
            maximum=MAX_RESULT_ITEMS,
            field="limit",
        )
        entries: list[dict[str, Any]] = []
        try:
            candidates = sorted(target.iterdir(), key=lambda value: value.name)
        except OSError as error:
            raise ReadonlyToolValidationError(
                "ls目标不可读取",
                code="READ_TOOL_TARGET_UNREADABLE",
            ) from error
        for candidate in candidates:
            if candidate.name == ".git":
                continue
            candidate_relative = candidate.relative_to(root).as_posix() if candidate != root else "."
            if _is_protected_source(candidate_relative):
                continue
            try:
                metadata = candidate.lstat()
            except OSError:
                continue
            if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata):
                kind = "blocked_link"
            elif stat.S_ISDIR(metadata.st_mode):
                kind = "directory"
            elif stat.S_ISREG(metadata.st_mode):
                kind = "file"
            else:
                kind = "other"
            entries.append({"name": candidate.name, "kind": kind})
            if len(entries) >= limit:
                break
        return {
            "path": relative,
            "entries": entries,
            "truncated": len(entries) < len(candidates),
        }

    @staticmethod
    def _find(root: Path, arguments: Mapping[str, Any]) -> dict[str, Any]:
        pattern = str(arguments.get("pattern") or "").strip()
        if not pattern or len(pattern) > 200:
            raise ReadonlyToolValidationError(
                "find pattern必须为1到200个字符",
                code="READ_TOOL_ARGUMENT_INVALID",
            )
        relative = _relative_path(arguments.get("path"))
        target = _resolve_entry(root, relative)
        if not target.is_dir():
            raise ReadonlyToolValidationError(
                "find目标必须是目录",
                code="READ_TOOL_EXPECTED_DIRECTORY",
            )
        limit = _positive_int(
            arguments.get("limit"),
            default=200,
            maximum=MAX_RESULT_ITEMS,
            field="limit",
        )
        matches: list[str] = []
        scanned = 0
        for candidate in _visible_tree(target):
            candidate_relative = candidate.relative_to(root).as_posix()
            if _is_protected_source(candidate_relative):
                continue
            scanned += 1
            if fnmatch.fnmatch(candidate.name, pattern) or fnmatch.fnmatch(
                candidate_relative,
                pattern,
            ):
                matches.append(candidate_relative)
                if len(matches) >= limit:
                    break
        return {
            "path": relative,
            "pattern": pattern,
            "matches": matches,
            "scanned_files": scanned,
            "truncated": len(matches) >= limit or scanned >= MAX_SCAN_FILES,
        }

    @staticmethod
    def _grep(root: Path, arguments: Mapping[str, Any]) -> dict[str, Any]:
        pattern = str(arguments.get("pattern") or "")
        if not pattern or len(pattern) > 500:
            raise ReadonlyToolValidationError(
                "grep pattern必须为1到500个字符",
                code="READ_TOOL_ARGUMENT_INVALID",
            )
        use_regex = bool(arguments.get("regex", False))
        if use_regex:
            try:
                matcher = re.compile(pattern)
            except re.error as error:
                raise ReadonlyToolValidationError(
                    "grep正则表达式无效",
                    code="READ_TOOL_ARGUMENT_INVALID",
                ) from error
        else:
            matcher = None
        relative = _relative_path(arguments.get("path"))
        target = _resolve_entry(root, relative)
        if target.is_file():
            _assert_source_allowed(relative)
        limit = _positive_int(
            arguments.get("limit"),
            default=100,
            maximum=100,
            field="limit",
        )
        candidates = [target] if target.is_file() else _visible_tree(target)
        matches: list[dict[str, Any]] = []
        scanned_files = 0
        scanned_bytes = 0
        for candidate in candidates:
            if not candidate.is_file():
                continue
            candidate_relative = candidate.relative_to(root).as_posix()
            if _is_protected_source(candidate_relative):
                continue
            try:
                size = candidate.stat().st_size
            except OSError:
                continue
            if size > MAX_READ_BYTES or scanned_bytes + size > MAX_SCAN_BYTES:
                continue
            try:
                raw = candidate.read_bytes()
            except OSError:
                continue
            if b"\x00" in raw:
                continue
            scanned_files += 1
            scanned_bytes += len(raw)
            for line_number, line in enumerate(
                raw.decode("utf-8", errors="replace").splitlines(),
                start=1,
            ):
                matched = bool(matcher.search(line)) if matcher else pattern in line
                if not matched:
                    continue
                matches.append(
                    {
                        "path": candidate.relative_to(root).as_posix(),
                        "line": line_number,
                        "text": line[:1_000],
                    }
                )
                if len(matches) >= limit:
                    break
            if len(matches) >= limit:
                break
        return {
            "path": relative,
            "pattern": pattern,
            "regex": use_regex,
            "matches": matches,
            "scanned_files": scanned_files,
            "scanned_bytes": scanned_bytes,
            "truncated": len(matches) >= limit or scanned_files >= MAX_SCAN_FILES,
        }

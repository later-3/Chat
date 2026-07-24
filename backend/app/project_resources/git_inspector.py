"""Strictly read-only Git inspection for Project repository snapshots."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import stat
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable

from ..product_sessions.database import utc_now
from .contracts import (
    RepositoryInspection,
    RepositoryInspectionError,
    repository_semantic_hash,
    sha256_json,
)
from .paths import SafeRepositoryPath

logger = logging.getLogger(__name__)
OBJECT_ID_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$")

GOVERNANCE_DOCUMENTS: tuple[tuple[str, str], ...] = (
    ("AGENTS.md", "agent_rules"),
    ("CLAUDE.md", "agent_rules"),
    ("PROJECT_CONTEXT.md", "project_context"),
    ("PROJECT_STATE.md", "project_state"),
    ("PROJECT_PLAN.md", "project_plan"),
    ("PROJECT_LESSONS.md", "project_lessons"),
    ("README.md", "project_readme"),
    ("docs/engineering-standards.md", "engineering_standard"),
)


@dataclass(frozen=True, slots=True)
class _GitChange:
    path: bytes
    original_path: bytes | None
    xy: str
    kind: str


@dataclass(frozen=True, slots=True)
class _StatusResult:
    changes: tuple[_GitChange, ...]
    upstream_ref: str | None
    ahead_count: int
    behind_count: int


@dataclass(frozen=True, slots=True)
class _GitResult:
    stdout: bytes
    stderr: bytes
    returncode: int


class _OutputLimitExceeded(Exception):
    pass


def _display_path(value: bytes) -> str:
    """Preserve valid Unicode and visibly escape undecodable filename bytes."""

    decoded = value.decode("utf-8", errors="surrogateescape")
    return decoded.encode("utf-8", errors="backslashreplace").decode("utf-8")


def _path_identity(value: bytes) -> str:
    """Canonical filename identity independent of JSON Unicode edge cases."""

    return value.hex()


def _safe_status_path(value: bytes) -> None:
    if not value or value.startswith((b"/", b"\\")):
        raise RepositoryInspectionError(
            "Git返回了不安全的路径",
            code="REPOSITORY_GIT_OUTPUT_INVALID",
        )
    segments = value.split(b"/")
    if any(segment in {b"", b".", b".."} for segment in segments):
        raise RepositoryInspectionError(
            "Git返回了不安全的路径",
            code="REPOSITORY_GIT_OUTPUT_INVALID",
        )


def _parse_status(payload: bytes) -> _StatusResult:
    """Parse porcelain-v2 ``-z`` without filename quoting assumptions."""

    records = payload.split(b"\0")
    changes: list[_GitChange] = []
    upstream_ref: str | None = None
    ahead_count = 0
    behind_count = 0
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if record.startswith(b"# branch.upstream "):
            upstream_ref = record.removeprefix(b"# branch.upstream ").decode(
                "utf-8",
                errors="replace",
            )
            continue
        if record.startswith(b"# branch.ab "):
            parts = record.removeprefix(b"# branch.ab ").split()
            if len(parts) == 2:
                try:
                    ahead_count = int(parts[0].removeprefix(b"+"))
                    behind_count = int(parts[1].removeprefix(b"-"))
                except ValueError as error:
                    raise RepositoryInspectionError(
                        "Git分支计数无法解析",
                        code="REPOSITORY_GIT_OUTPUT_INVALID",
                    ) from error
            continue
        if record.startswith(b"# "):
            continue
        if record.startswith(b"1 "):
            fields = record.split(b" ", 8)
            if len(fields) != 9:
                raise RepositoryInspectionError(
                    "Git状态记录无法解析",
                    code="REPOSITORY_GIT_OUTPUT_INVALID",
                )
            path = fields[8]
            _safe_status_path(path)
            changes.append(
                _GitChange(
                    path=path,
                    original_path=None,
                    xy=fields[1].decode("ascii", errors="replace"),
                    kind="ordinary",
                )
            )
            continue
        if record.startswith(b"2 "):
            fields = record.split(b" ", 9)
            if len(fields) != 10 or index >= len(records):
                raise RepositoryInspectionError(
                    "Git重命名状态无法解析",
                    code="REPOSITORY_GIT_OUTPUT_INVALID",
                )
            path = fields[9]
            original_path = records[index]
            index += 1
            _safe_status_path(path)
            _safe_status_path(original_path)
            changes.append(
                _GitChange(
                    path=path,
                    original_path=original_path,
                    xy=fields[1].decode("ascii", errors="replace"),
                    kind="rename",
                )
            )
            continue
        if record.startswith(b"u "):
            fields = record.split(b" ", 10)
            if len(fields) != 11:
                raise RepositoryInspectionError(
                    "Git冲突状态无法解析",
                    code="REPOSITORY_GIT_OUTPUT_INVALID",
                )
            path = fields[10]
            _safe_status_path(path)
            changes.append(
                _GitChange(
                    path=path,
                    original_path=None,
                    xy=fields[1].decode("ascii", errors="replace"),
                    kind="unmerged",
                )
            )
            continue
        if record.startswith(b"? "):
            path = record[2:]
            _safe_status_path(path)
            changes.append(_GitChange(path=path, original_path=None, xy="??", kind="untracked"))
            continue
        raise RepositoryInspectionError(
            "Git返回了未知状态记录",
            code="REPOSITORY_GIT_OUTPUT_INVALID",
        )
    return _StatusResult(
        changes=tuple(changes),
        upstream_ref=upstream_ref,
        ahead_count=ahead_count,
        behind_count=behind_count,
    )


def _parse_index_records(payload: bytes) -> dict[bytes, tuple[str, str]]:
    values: dict[bytes, tuple[str, str]] = {}
    for record in payload.split(b"\0"):
        if not record:
            continue
        metadata, separator, path = record.partition(b"\t")
        parts = metadata.split()
        if not separator or len(parts) != 3:
            raise RepositoryInspectionError(
                "Git索引记录无法解析",
                code="REPOSITORY_GIT_OUTPUT_INVALID",
            )
        mode, oid, stage = parts
        if stage != b"0":
            continue
        values[path] = (
            mode.decode("ascii", errors="replace"),
            oid.decode("ascii", errors="replace"),
        )
    return values


class ReadOnlyGitInspector:
    """Observe one exact repository root without invoking mutating Git paths."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 10.0,
        output_limit_bytes: int = 16 * 1024 * 1024,
        max_changed_paths: int = 5000,
        max_dirty_bytes: int = 64 * 1024 * 1024,
        max_change_summary: int = 200,
        max_governance_bytes: int = 256 * 1024,
        clock: Callable[[], datetime] = utc_now,
        git_executable: str = "git",
    ) -> None:
        if timeout_seconds <= 0 or output_limit_bytes <= 0:
            raise ValueError("Git Inspector timeout和output limit必须为正数")
        if (
            min(
                max_changed_paths,
                max_dirty_bytes,
                max_change_summary,
                max_governance_bytes,
            )
            <= 0
        ):
            raise ValueError("Git Inspector容量限制必须为正数")
        self.timeout_seconds = timeout_seconds
        self.output_limit_bytes = output_limit_bytes
        self.max_changed_paths = max_changed_paths
        self.max_dirty_bytes = max_dirty_bytes
        self.max_change_summary = max_change_summary
        self.max_governance_bytes = max_governance_bytes
        self._clock = clock
        self._git_executable = git_executable

    async def inspect(
        self,
        repository: SafeRepositoryPath,
        *,
        binding_generation: int,
    ) -> RepositoryInspection:
        started = time.monotonic()
        result_code = "available"
        try:
            await self._validate_repository_root(repository.absolute_path)
            head_oid = await self._head_oid(repository.absolute_path)
            head_ref = await self._head_ref(repository.absolute_path)
            status = _parse_status(
                (
                    await self._run_git(
                        repository.absolute_path,
                        "status",
                        "--porcelain=v2",
                        "-z",
                        "--branch",
                        "--untracked-files=all",
                    )
                ).stdout
            )
            manifest, manifest_hash = self._governance_manifest(repository.absolute_path)
            (
                worktree_fingerprint,
                fingerprint_complete,
                summary,
            ) = await self._worktree_fingerprint(
                repository.absolute_path,
                head_oid=head_oid,
                changes=status.changes,
                governance_manifest_hash=manifest_hash,
            )
            unique_paths = {change.path for change in status.changes}
            staged_count = sum(
                1
                for change in status.changes
                if change.kind != "untracked" and change.xy[:1] not in {"", ".", " "}
            )
            unstaged_count = sum(
                1
                for change in status.changes
                if change.kind != "untracked" and change.xy[1:2] not in {"", ".", " "}
            )
            untracked_count = sum(1 for change in status.changes if change.kind == "untracked")
            semantic_hash = repository_semantic_hash(
                binding_generation=binding_generation,
                locator_hash_value=repository.locator_hash,
                head_oid=head_oid,
                head_ref=head_ref,
                detached_head=head_ref is None and head_oid is not None,
                worktree_fingerprint=worktree_fingerprint,
                fingerprint_complete=fingerprint_complete,
                governance_manifest_hash=manifest_hash,
            )
            return RepositoryInspection(
                observed_at=self._clock(),
                head_oid=head_oid,
                head_ref=head_ref,
                upstream_ref=status.upstream_ref,
                detached_head=head_ref is None and head_oid is not None,
                ahead_count=status.ahead_count,
                behind_count=status.behind_count,
                dirty=bool(status.changes),
                staged_count=staged_count,
                unstaged_count=unstaged_count,
                untracked_count=untracked_count,
                change_count=len(unique_paths),
                changes_truncated=len(status.changes) > self.max_change_summary,
                change_summary=summary,
                fingerprint_complete=fingerprint_complete,
                worktree_fingerprint=worktree_fingerprint,
                governance_manifest=manifest,
                governance_manifest_hash=manifest_hash,
                semantic_hash=semantic_hash,
            )
        except RepositoryInspectionError as error:
            result_code = error.code
            raise
        finally:
            logger.info(
                "repository_git_inspection_finished result=%s duration_ms=%d",
                result_code,
                int((time.monotonic() - started) * 1000),
            )

    async def _validate_repository_root(self, path: Path) -> None:
        inside = await self._run_git(
            path,
            "rev-parse",
            "--is-inside-work-tree",
            ok_codes=(0, 128),
        )
        if inside.returncode != 0 or inside.stdout.strip() != b"true":
            raise RepositoryInspectionError(
                "目录不是可用的Git工作树",
                code="REPOSITORY_NOT_GIT",
            )
        top_level = await self._run_git(path, "rev-parse", "--show-toplevel")
        try:
            actual_root = Path(os.fsdecode(top_level.stdout.rstrip(b"\r\n"))).resolve(strict=True)
        except (OSError, ValueError) as error:
            raise RepositoryInspectionError(
                "Git仓库根目录无法解析",
                code="REPOSITORY_GIT_OUTPUT_INVALID",
            ) from error
        if actual_root != path:
            raise RepositoryInspectionError(
                "只能绑定完整Git仓库根目录，不能绑定其子目录",
                code="REPOSITORY_SUBDIRECTORY_REJECTED",
            )

    async def _head_oid(self, path: Path) -> str | None:
        result = await self._run_git(
            path,
            "rev-parse",
            "--verify",
            "HEAD",
            ok_codes=(0, 128),
        )
        if result.returncode == 128:
            return None
        oid = result.stdout.strip().decode("ascii", errors="replace")
        if not OBJECT_ID_PATTERN.fullmatch(oid):
            raise RepositoryInspectionError(
                "Git HEAD无法解析",
                code="REPOSITORY_GIT_OUTPUT_INVALID",
            )
        return oid

    async def _head_ref(self, path: Path) -> str | None:
        result = await self._run_git(
            path,
            "symbolic-ref",
            "-q",
            "HEAD",
            ok_codes=(0, 1),
        )
        if result.returncode == 1:
            return None
        value = result.stdout.rstrip(b"\r\n").decode("utf-8", errors="replace")
        if len(value) > 255:
            raise RepositoryInspectionError(
                "Git分支引用超过安全上限",
                code="REPOSITORY_GIT_OUTPUT_INVALID",
            )
        return value or None

    async def _index_entries(
        self,
        path: Path,
        paths: Iterable[bytes],
    ) -> dict[bytes, tuple[str, str]]:
        values: dict[bytes, tuple[str, str]] = {}
        batch: list[bytes] = []
        for value in paths:
            batch.append(value)
            if len(batch) >= 200:
                values.update(await self._index_batch(path, batch))
                batch.clear()
        if batch:
            values.update(await self._index_batch(path, batch))
        return values

    async def _index_batch(
        self,
        path: Path,
        paths: list[bytes],
    ) -> dict[bytes, tuple[str, str]]:
        result = await self._run_git(
            path,
            "ls-files",
            "--stage",
            "-z",
            "--",
            *(os.fsdecode(value) for value in paths),
        )
        return _parse_index_records(result.stdout)

    async def _worktree_fingerprint(
        self,
        repository_root: Path,
        *,
        head_oid: str | None,
        changes: tuple[_GitChange, ...],
        governance_manifest_hash: str,
    ) -> tuple[str, bool, tuple[dict[str, str], ...]]:
        ordered = sorted(changes, key=lambda value: (value.path, value.xy, value.kind))
        unique_ordered: list[_GitChange] = []
        seen: set[bytes] = set()
        for change in ordered:
            if change.path not in seen:
                unique_ordered.append(change)
                seen.add(change.path)
        summary = tuple(
            {
                "path": _display_path(change.path),
                "status": change.xy,
                "kind": change.kind,
            }
            for change in unique_ordered[: self.max_change_summary]
        )
        fingerprint_complete = len(unique_ordered) <= self.max_changed_paths
        selected = unique_ordered[: self.max_changed_paths]
        index_entries = await self._index_entries(
            repository_root,
            (change.path for change in selected if change.kind != "untracked"),
        )
        total_hashed = 0
        entries: list[dict[str, object]] = []
        for change in selected:
            index_mode, index_oid = index_entries.get(change.path, ("", ""))
            content_kind, content_hash, consumed, complete = self._content_identity(
                repository_root,
                change.path,
                remaining_bytes=max(self.max_dirty_bytes - total_hashed, 0),
                index_mode=index_mode,
            )
            total_hashed += consumed
            fingerprint_complete = fingerprint_complete and complete
            entries.append(
                {
                    "path_hex": _path_identity(change.path),
                    "original_path_hex": (
                        _path_identity(change.original_path) if change.original_path else ""
                    ),
                    "status": change.xy,
                    "kind": change.kind,
                    "index_mode": index_mode,
                    "index_oid": index_oid,
                    "content_kind": content_kind,
                    "content_hash": content_hash,
                }
            )
        fingerprint = sha256_json(
            {
                "schema": "repository-worktree-v1",
                "head_oid": head_oid or "UNBORN",
                "entries": entries,
                "observed_change_count": len(unique_ordered),
                "fingerprint_complete": fingerprint_complete,
                "governance_manifest_hash": governance_manifest_hash,
            }
        )
        return fingerprint, fingerprint_complete, summary

    def _content_identity(
        self,
        repository_root: Path,
        relative_path: bytes,
        *,
        remaining_bytes: int,
        index_mode: str,
    ) -> tuple[str, str, int, bool]:
        _safe_status_path(relative_path)
        current = repository_root
        segments = relative_path.split(b"/")
        for segment in segments[:-1]:
            current = current / os.fsdecode(segment)
            try:
                metadata = current.lstat()
            except OSError:
                return "race_missing", "RACE_MISSING", 0, False
            if stat.S_ISLNK(metadata.st_mode):
                raise RepositoryInspectionError(
                    "Git变化路径经过符号链接",
                    code="REPOSITORY_SYMLINK_REJECTED",
                )
        current = current / os.fsdecode(segments[-1])
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return "deleted", "DELETED", 0, True
        except OSError:
            return "unreadable", "UNREADABLE", 0, False
        if stat.S_ISLNK(metadata.st_mode):
            try:
                target = os.readlink(current)
            except OSError:
                return "symlink_unreadable", "SYMLINK_UNREADABLE", 0, False
            digest = hashlib.sha256(os.fsencode(target)).hexdigest()
            return "symlink", digest, len(os.fsencode(target)), True
        if stat.S_ISDIR(metadata.st_mode):
            if index_mode == "160000":
                return "gitlink", "GITLINK", 0, True
            return "directory", "DIRECTORY", 0, False
        if not stat.S_ISREG(metadata.st_mode):
            return "special", f"SPECIAL:{metadata.st_mode}", 0, False
        if remaining_bytes <= 0:
            return "content_cap", f"CONTENT_CAP:{metadata.st_size}", 0, False
        digest = hashlib.sha256()
        consumed = 0
        complete = True
        try:
            with current.open("rb") as stream:
                while True:
                    chunk = stream.read(min(1024 * 1024, remaining_bytes - consumed + 1))
                    if not chunk:
                        break
                    allowed = min(len(chunk), remaining_bytes - consumed)
                    if allowed > 0:
                        digest.update(chunk[:allowed])
                        consumed += allowed
                    if allowed < len(chunk) or consumed >= remaining_bytes:
                        if stream.read(1) or allowed < len(chunk):
                            complete = False
                        break
        except OSError:
            return "unreadable", "UNREADABLE", consumed, False
        try:
            after = current.stat(follow_symlinks=False)
        except OSError:
            complete = False
        else:
            if (
                after.st_ino != metadata.st_ino
                or after.st_size != metadata.st_size
                or after.st_mtime_ns != metadata.st_mtime_ns
            ):
                complete = False
        marker = digest.hexdigest()
        if not complete:
            marker = f"{marker}:CONTENT_CAP:{metadata.st_size}"
        return "regular", marker, consumed, complete

    def _governance_manifest(
        self,
        repository_root: Path,
    ) -> tuple[tuple[dict[str, object], ...], str]:
        values: list[dict[str, object]] = []
        for relative, kind in GOVERNANCE_DOCUMENTS:
            current = repository_root
            rejected = False
            metadata: os.stat_result | None = None
            for segment in relative.split("/"):
                current = current / segment
                try:
                    metadata = current.lstat()
                except FileNotFoundError:
                    rejected = True
                    break
                except OSError:
                    rejected = True
                    break
                if stat.S_ISLNK(metadata.st_mode):
                    rejected = True
                    break
            if rejected or metadata is None or not stat.S_ISREG(metadata.st_mode):
                continue
            if metadata.st_size > self.max_governance_bytes:
                continue
            try:
                content = current.read_bytes()
                content.decode("utf-8", errors="strict")
            except (OSError, UnicodeDecodeError):
                continue
            values.append(
                {
                    "path": relative,
                    "kind": kind,
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "size_bytes": len(content),
                }
            )
        manifest = tuple(values)
        return manifest, sha256_json(
            {
                "schema": "repository-governance-manifest-v1",
                "documents": values,
            }
        )

    async def _run_git(
        self,
        cwd: Path,
        *arguments: str,
        ok_codes: tuple[int, ...] = (0,),
    ) -> _GitResult:
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(
            {
                "GIT_OPTIONAL_LOCKS": "0",
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_EXTERNAL_DIFF": "",
                "GIT_PAGER": "cat",
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_SYSTEM": os.devnull,
            }
        )
        try:
            process = await asyncio.create_subprocess_exec(
                self._git_executable,
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                *arguments,
                cwd=cwd,
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as error:
            raise RepositoryInspectionError(
                "Git可执行程序不可用",
                code="REPOSITORY_GIT_UNAVAILABLE",
            ) from error
        assert process.stdout is not None
        assert process.stderr is not None
        try:
            stdout, stderr, returncode = await asyncio.wait_for(
                self._communicate_limited(process),
                timeout=self.timeout_seconds,
            )
        except TimeoutError as error:
            process.kill()
            await process.wait()
            raise RepositoryInspectionError(
                "Git只读检查超时",
                code="REPOSITORY_INSPECTION_TIMEOUT",
            ) from error
        except _OutputLimitExceeded as error:
            process.kill()
            await process.wait()
            raise RepositoryInspectionError(
                "Git只读检查输出超过安全上限",
                code="REPOSITORY_INSPECTION_TOO_LARGE",
            ) from error
        result = _GitResult(stdout=stdout, stderr=stderr, returncode=returncode)
        if returncode not in ok_codes:
            raise RepositoryInspectionError(
                "Git只读检查失败",
                code="REPOSITORY_INSPECTION_FAILED",
            )
        return result

    async def _communicate_limited(
        self,
        process: asyncio.subprocess.Process,
    ) -> tuple[bytes, bytes, int]:
        assert process.stdout is not None
        assert process.stderr is not None

        async def read(stream: asyncio.StreamReader) -> bytes:
            body = bytearray()
            while chunk := await stream.read(64 * 1024):
                body.extend(chunk)
                if len(body) > self.output_limit_bytes:
                    raise _OutputLimitExceeded
            return bytes(body)

        stdout_task = asyncio.create_task(read(process.stdout))
        stderr_task = asyncio.create_task(read(process.stderr))
        wait_task = asyncio.create_task(process.wait())
        try:
            stdout, stderr, returncode = await asyncio.gather(
                stdout_task,
                stderr_task,
                wait_task,
            )
        finally:
            for task in (stdout_task, stderr_task, wait_task):
                if not task.done():
                    task.cancel()
        return stdout, stderr, returncode

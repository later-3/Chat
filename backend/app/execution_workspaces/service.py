"""Application service and Git adapter for managed execution workspaces."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import select

from ..execution_dispatch.contracts import RepositoryFence
from ..execution_dispatch.repository_context import RepositoryExecutionContextService
from ..harness.contracts import content_hash
from ..product_sessions.database import ProductDatabase, ToolExecutionRecord, utc_now
from ..project_resources.models import RepositorySnapshotRecord
from .models import ExecutionWorkspaceRecord

logger = logging.getLogger(__name__)

_ACTIVE_STATUSES = frozenset({"ready", "running", "validating"})
_TERMINAL_STATUSES = frozenset({"retained", "integrated", "discarded", "failed"})


class ExecutionWorkspaceError(RuntimeError):
    """Safe workspace failure with a stable product error code."""

    def __init__(self, message: str, *, code: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class WorkspaceOwnership:
    """Runtime lineage that owns one isolated workspace."""

    scope_id: str
    product_run_id: str
    run_attempt_id: str
    runtime_job_id: str
    tool_execution_id: str


def _redact_git_stderr(text: str, cwd: Path) -> str:
    """Redact private absolute paths and secret-shaped tokens from git stderr.

    Used only for server-side diagnostics; the domain message itself stays a
    safe classification.  Redaction always runs on the *full* text before any
    length cap, so secrets beyond 300 characters are still stripped (第六轮1)。
    """

    redacted = text.replace(str(cwd), "<workspace>")
    redacted = re.sub(r"(?<![\w.])(?:/[A-Za-z0-9._+~\-%]+){2,}", "<path>", redacted)
    redacted = re.sub(
        r"(?i)(api[_-]?key|token|authorization|password)\s*[:=]\s*\S+", r"\1=[redacted]", redacted
    )
    redacted = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "[redacted]", redacted)
    return redacted


class ExecutionWorkspaceService:
    """Own workspace lifecycle while a narrow adapter owns Git/filesystem calls."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        repository_context: RepositoryExecutionContextService,
        managed_root: Path,
        git_timeout_seconds: int = 30,
    ) -> None:
        self.database = database
        self._repository_context = repository_context
        self._managed_root = managed_root.expanduser().resolve()
        self._git_timeout_seconds = git_timeout_seconds

    async def create(
        self,
        *,
        ownership: WorkspaceOwnership,
        fence: RepositoryFence,
    ) -> dict[str, Any]:
        """Create one detached worktree from the exact clean approved snapshot."""

        source = await self._repository_context.resolve_private_path(fence)
        async with self.database.sessions() as transaction:
            snapshot = await transaction.get(RepositorySnapshotRecord, fence.snapshot_id)
            if snapshot is None or snapshot.binding_id != fence.binding_id:
                raise ExecutionWorkspaceError(
                    "Execution Workspace缺少Repository Snapshot",
                    code="EXECUTION_WORKSPACE_SNAPSHOT_MISSING",
                )
            if (
                snapshot.capture_status != "available"
                or snapshot.dirty
                or not snapshot.fingerprint_complete
                or not snapshot.head_oid
                or snapshot.head_oid != fence.head_oid
            ):
                raise ExecutionWorkspaceError(
                    "Execution Workspace只接受具有完整指纹的干净Git Snapshot",
                    code="EXECUTION_WORKSPACE_SNAPSHOT_UNSAFE",
                )

        workspace_id = str(uuid4())
        workspace_key = f"ws-{workspace_id}"
        value = ExecutionWorkspaceRecord(
            id=workspace_id,
            scope_id=ownership.scope_id,
            product_run_id=ownership.product_run_id,
            run_attempt_id=ownership.run_attempt_id,
            runtime_job_id=ownership.runtime_job_id,
            tool_execution_id=ownership.tool_execution_id,
            repository_binding_id=fence.binding_id,
            repository_snapshot_id=fence.snapshot_id,
            workspace_key=workspace_key,
            workspace_kind="managed_git_worktree",
            root_key=fence.root_key,
            source_relative_path=fence.relative_path,
            base_revision=str(fence.head_oid),
            status="preparing",
            changed_paths_json=[],
        )
        async with self.database.sessions.begin() as transaction:
            existing = await transaction.scalar(
                select(ExecutionWorkspaceRecord).where(
                    ExecutionWorkspaceRecord.tool_execution_id == ownership.tool_execution_id
                )
            )
            if existing is not None:
                return self._view(existing)
            transaction.add(value)

        target = self._path_for_key(workspace_key)
        try:
            await asyncio.to_thread(self._managed_root.mkdir, parents=True, exist_ok=True)
            await self._run_git(
                source,
                "worktree",
                "add",
                "--detach",
                str(target),
                str(fence.head_oid),
            )
            observed = (await self._run_git(target, "rev-parse", "HEAD")).strip()
            if observed != fence.head_oid:
                raise ExecutionWorkspaceError(
                    "Execution Workspace HEAD与批准Snapshot不一致",
                    code="EXECUTION_WORKSPACE_HEAD_MISMATCH",
                )
        except Exception as error:
            code = getattr(error, "code", "EXECUTION_WORKSPACE_CREATE_FAILED")
            await self._mark_failed(workspace_id, code=str(code))
            raise

        async with self.database.sessions.begin() as transaction:
            record = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if record is None or record.status != "preparing":
                raise ExecutionWorkspaceError(
                    "Execution Workspace创建状态冲突",
                    code="EXECUTION_WORKSPACE_CREATE_CONFLICT",
                )
            record.status = "ready"
            record.observed_head_oid = observed
            record.ready_at = utc_now()
            record.row_version += 1
        logger.info(
            "execution_workspace_ready workspace_id=%s run_id=%s snapshot_id=%s base_revision=%s",
            workspace_id,
            ownership.product_run_id,
            fence.snapshot_id,
            str(fence.head_oid)[:12],
        )
        return await self.get(workspace_id)

    async def mark_running(self, workspace_id: str) -> dict[str, Any]:
        return await self._transition(workspace_id, expected={"ready", "running"}, target="running")

    async def retain(self, workspace_id: str) -> dict[str, Any]:
        """Freeze the public diff projection without integrating it."""

        await self._transition(
            workspace_id,
            expected={"ready", "running", "validating"},
            target="validating",
        )
        await self.refresh_diff(workspace_id)
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None or value.status != "validating":
                raise ExecutionWorkspaceError(
                    "Execution Workspace保留状态冲突",
                    code="EXECUTION_WORKSPACE_RETAIN_CONFLICT",
                )
            value.status = "retained"
            value.retained_at = utc_now()
            value.finished_at = value.retained_at
            value.row_version += 1
        logger.info("execution_workspace_retained workspace_id=%s", workspace_id)
        return await self.get(workspace_id)

    async def refresh_diff(self, workspace_id: str) -> dict[str, Any]:
        root = await self.private_path(workspace_id)
        raw_status = await self._run_git_bytes(root, "status", "--porcelain=v1", "-z")
        paths = self._changed_paths(raw_status)
        fingerprints: list[dict[str, Any]] = []
        for relative in paths:
            target = root / relative
            try:
                metadata = target.lstat()
            except OSError:
                fingerprints.append({"path": relative, "kind": "missing"})
                continue
            if stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                digest = hashlib.sha256(await asyncio.to_thread(target.read_bytes)).hexdigest()
                fingerprints.append({"path": relative, "kind": "file", "hash": digest})
            else:
                fingerprints.append({"path": relative, "kind": "non_regular"})
        diff_hash = content_hash(
            {
                "status_hash": hashlib.sha256(raw_status).hexdigest(),
                "paths": fingerprints,
            }
        )
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None:
                raise ExecutionWorkspaceError(
                    "Execution Workspace不存在",
                    code="EXECUTION_WORKSPACE_NOT_FOUND",
                )
            if value.status not in _ACTIVE_STATUSES:
                raise ExecutionWorkspaceError(
                    "Execution Workspace终态不能刷新变化",
                    code="EXECUTION_WORKSPACE_TERMINAL",
                )
            value.changed_paths_json = paths
            value.diff_hash = diff_hash
            value.row_version += 1
        return await self.get(workspace_id)

    async def reconcile_preparing(self) -> int:
        """Settle startup leftovers without replaying `git worktree add`."""

        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(ExecutionWorkspaceRecord).where(ExecutionWorkspaceRecord.status == "preparing")
                    )
                ).all()
            )
        settled = 0
        for value in values:
            target = self._path_for_key(value.workspace_key)
            observed: str | None = None
            if target.is_dir():
                try:
                    observed = (await self._run_git(target, "rev-parse", "HEAD")).strip()
                except ExecutionWorkspaceError:
                    observed = None
            async with self.database.sessions.begin() as transaction:
                current = await transaction.get(ExecutionWorkspaceRecord, value.id)
                if current is None or current.status != "preparing":
                    continue
                if observed == current.base_revision:
                    current.status = "ready"
                    current.observed_head_oid = observed
                    current.ready_at = utc_now()
                else:
                    current.status = "failed"
                    current.failure_code = "execution_workspace_create_interrupted"
                    current.finished_at = utc_now()
                current.row_version += 1
                settled += 1
        return settled

    async def reconcile_orphans(self) -> int:
        """Retain active workspaces whose owning ToolExecution is terminal.

        The ToolExecution startup reconciler runs first and marks processes that
        disappeared as ``interrupted``. This method then freezes their isolated
        filesystem result instead of replaying work or leaving an apparently
        active workspace behind.
        """

        terminal_execution_statuses = (
            "succeeded",
            "failed",
            "cancelled",
            "abandoned",
            "interrupted",
        )
        async with self.database.sessions() as transaction:
            workspace_ids = list(
                (
                    await transaction.scalars(
                        select(ExecutionWorkspaceRecord.id)
                        .join(
                            ToolExecutionRecord,
                            ToolExecutionRecord.id == ExecutionWorkspaceRecord.tool_execution_id,
                        )
                        .where(
                            ExecutionWorkspaceRecord.status.in_(_ACTIVE_STATUSES),
                            ToolExecutionRecord.status.in_(terminal_execution_statuses),
                        )
                    )
                ).all()
            )
        settled = 0
        for workspace_id in workspace_ids:
            try:
                await self.retain(workspace_id)
            except Exception as error:
                await self._mark_failed(
                    workspace_id,
                    code="execution_workspace_orphan_retain_failed",
                )
                logger.warning(
                    "execution_workspace_orphan_retain_failed workspace_id=%s error_type=%s",
                    workspace_id,
                    type(error).__name__,
                )
            settled += 1
        return settled

    async def retain_for_terminal_run(self, run_id: str) -> int:
        """Freeze active workspaces without making Run cancellation fail.

        Product cancellation is already authoritative when this best-effort
        filesystem projection runs. A broken or missing worktree must remain
        visible as a failed workspace, but it must not turn an accepted cancel
        request into an HTTP failure after the Run reached a terminal state.
        """

        async with self.database.sessions() as transaction:
            workspace_ids = list(
                (
                    await transaction.scalars(
                        select(ExecutionWorkspaceRecord.id).where(
                            ExecutionWorkspaceRecord.product_run_id == run_id,
                            ExecutionWorkspaceRecord.status.in_(_ACTIVE_STATUSES),
                        )
                    )
                ).all()
            )
        for workspace_id in workspace_ids:
            try:
                await self.retain(workspace_id)
            except Exception as error:
                await self._mark_failed(
                    workspace_id,
                    code="execution_workspace_terminal_retain_failed",
                )
                logger.warning(
                    "execution_workspace_terminal_retain_failed workspace_id=%s run_id=%s error_type=%s",
                    workspace_id,
                    run_id,
                    type(error).__name__,
                )
        return len(workspace_ids)

    async def get(self, workspace_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None:
                raise ExecutionWorkspaceError(
                    "Execution Workspace不存在",
                    code="EXECUTION_WORKSPACE_NOT_FOUND",
                )
            return self._view(value)

    async def get_for_tool_execution(self, tool_execution_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            value = await transaction.scalar(
                select(ExecutionWorkspaceRecord).where(
                    ExecutionWorkspaceRecord.tool_execution_id == tool_execution_id
                )
            )
            return self._view(value) if value is not None else None

    async def private_path(self, workspace_id: str) -> Path:
        """Resolve a workspace locator internally; never expose it in views or logs."""

        async with self.database.sessions() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None:
                raise ExecutionWorkspaceError(
                    "Execution Workspace不存在",
                    code="EXECUTION_WORKSPACE_NOT_FOUND",
                )
            key = value.workspace_key
        target = self._path_for_key(key)
        try:
            resolved = target.resolve(strict=True)
        except OSError as error:
            raise ExecutionWorkspaceError(
                "Execution Workspace目录不可用",
                code="EXECUTION_WORKSPACE_PATH_UNAVAILABLE",
            ) from error
        if resolved.parent != self._managed_root:
            raise ExecutionWorkspaceError(
                "Execution Workspace路径越过受管根目录",
                code="EXECUTION_WORKSPACE_PATH_ESCAPE",
            )
        return resolved

    async def diff_text(self, workspace_id: str, *, max_bytes: int = 512 * 1024) -> bytes:
        """Return the unified diff of a retained workspace against its base revision.

        SD4-C turns these bytes into the content-addressed diff_patch Artifact;
        the diff never leaves the server except as stored Artifact content.
        """

        root = await self.private_path(workspace_id)
        async with self.database.sessions() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None:
                raise ExecutionWorkspaceError(
                    "Execution Workspace不存在",
                    code="EXECUTION_WORKSPACE_NOT_FOUND",
                )
            base_revision = value.base_revision
        # 第四轮复审P1-6：显式禁用仓库配置的external diff与textconv——绑定仓库
        # 可能通过.gitattributes让服务端在结果组装时执行仓库配置的命令；
        # "--"终止选项解析，base revision不被当作路径。
        raw = await self._run_git_bytes(
            root,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            base_revision,
            "--",
        )
        if len(raw) > max_bytes:
            raise ExecutionWorkspaceError(
                "Execution Workspace Diff超过大小上限",
                code="EXECUTION_WORKSPACE_DIFF_TOO_LARGE",
            )
        return raw

    async def _transition(
        self,
        workspace_id: str,
        *,
        expected: set[str],
        target: str,
    ) -> dict[str, Any]:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None:
                raise ExecutionWorkspaceError(
                    "Execution Workspace不存在",
                    code="EXECUTION_WORKSPACE_NOT_FOUND",
                )
            if value.status not in expected:
                raise ExecutionWorkspaceError(
                    f"Execution Workspace不能从{value.status}进入{target}",
                    code="EXECUTION_WORKSPACE_STATE_CONFLICT",
                )
            if value.status != target:
                value.status = target
                value.row_version += 1
        return await self.get(workspace_id)

    async def _mark_failed(self, workspace_id: str, *, code: str) -> None:
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ExecutionWorkspaceRecord, workspace_id)
            if value is None or value.status in _TERMINAL_STATUSES:
                return
            value.status = "failed"
            value.failure_code = code[:100]
            value.finished_at = utc_now()
            value.row_version += 1

    def _path_for_key(self, workspace_key: str) -> Path:
        if not workspace_key.startswith("ws-") or "/" in workspace_key or "\\" in workspace_key:
            raise ExecutionWorkspaceError(
                "Execution Workspace locator无效",
                code="EXECUTION_WORKSPACE_LOCATOR_INVALID",
            )
        return self._managed_root / workspace_key

    async def _run_git(self, cwd: Path, *arguments: str) -> str:
        raw = await self._run_git_bytes(cwd, *arguments)
        return raw.decode("utf-8", errors="replace")

    async def _run_git_bytes(self, cwd: Path, *arguments: str) -> bytes:
        process: asyncio.subprocess.Process | None = None
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                str(cwd),
                *arguments,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self._git_timeout_seconds,
            )
        except TimeoutError as error:
            if process is not None:
                process.kill()
                await process.wait()
            raise ExecutionWorkspaceError(
                "Git Workspace操作超时",
                code="EXECUTION_WORKSPACE_GIT_TIMEOUT",
            ) from error
        except OSError as error:
            raise ExecutionWorkspaceError(
                "Git Runtime不可用",
                code="EXECUTION_WORKSPACE_GIT_UNAVAILABLE",
            ) from error
        if process.returncode != 0:
            # 第六轮复审P1-3：原始stderr不回显进领域消息（可能携带带空格/
            # 引号的本机绝对路径）；只保留安全分类，原文脱敏后只进服务端日志。
            logger.warning(
                "execution_workspace_git_failed workspace_cwd=%s exit=%s stderr=%s",
                "<workspace>",
                process.returncode,
                _redact_git_stderr(" ".join(stderr.decode("utf-8", errors="replace").split()), cwd)[:300],
            )
            raise ExecutionWorkspaceError(
                f"Git Workspace操作失败（退出码{process.returncode}）",
                code="EXECUTION_WORKSPACE_GIT_FAILED",
            )
        return stdout

    @staticmethod
    def _changed_paths(raw_status: bytes) -> list[str]:
        paths: set[str] = set()
        for item in raw_status.split(b"\x00"):
            if len(item) < 4:
                continue
            decoded = item[3:].decode("utf-8", errors="replace").strip()
            if decoded and not decoded.startswith("../") and decoded != ".git":
                paths.add(decoded)
        return sorted(paths)

    @staticmethod
    def _view(value: ExecutionWorkspaceRecord) -> dict[str, Any]:
        return {
            "id": value.id,
            "scope_id": value.scope_id,
            "product_run_id": value.product_run_id,
            "run_attempt_id": value.run_attempt_id,
            "runtime_job_id": value.runtime_job_id,
            "tool_execution_id": value.tool_execution_id,
            "repository_binding_id": value.repository_binding_id,
            "repository_snapshot_id": value.repository_snapshot_id,
            "workspace_kind": value.workspace_kind,
            "source": {
                "root_key": value.root_key,
                "relative_path": value.source_relative_path,
                "base_revision": value.base_revision,
            },
            "observed_head_oid": value.observed_head_oid,
            "status": value.status,
            "diff_hash": value.diff_hash,
            "changed_paths": list(value.changed_paths_json or []),
            "failure_code": value.failure_code,
            "row_version": value.row_version,
            "created_at": value.created_at.isoformat(),
            "ready_at": value.ready_at.isoformat() if value.ready_at else None,
            "retained_at": value.retained_at.isoformat() if value.retained_at else None,
            "finished_at": value.finished_at.isoformat() if value.finished_at else None,
        }

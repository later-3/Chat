"""Repository Context contribution, governance materialization and freshness.

This module is deliberately read-only.  It projects immutable repository
observations into Product Context and verifies that an approved model request
still references the latest available semantic snapshot before dispatch.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from sqlalchemy import select

from ..harness.contracts import HarnessConflict
from ..harness.models import ContextAdoptionRecord, ContextPackageRecord
from ..product_sessions.database import ProductDatabase
from ..product_sessions.service import DEFAULT_SCOPE_ID
from .catalog import WorkspaceRootCatalog
from .contracts import ProjectResourceError, canonical_json
from .git_inspector import GOVERNANCE_DOCUMENTS
from .models import ProjectRepositoryBindingRecord, RepositorySnapshotRecord
from .paths import resolve_repository_path
from .queries import ProjectResourceQueryService

logger = logging.getLogger(__name__)

REPOSITORY_SOURCE_KINDS = frozenset(
    {
        "repository_directory",
        "repository_snapshot",
        "repository_governance",
        "repository_governance_manifest",
    }
)
MAX_DEFAULT_GOVERNANCE_DOCUMENTS = 2
MAX_GOVERNANCE_CONTEXT_BYTES = 32 * 1024
MAX_GOVERNANCE_DOCUMENT_BYTES = 256 * 1024


class ContextSourceStale(HarnessConflict):
    """The immutable Context reference no longer describes the latest source."""

    code = "CONTEXT_SOURCE_STALE"

    def __init__(self, message: str, *, reason_code: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code


@dataclass(frozen=True, slots=True)
class _RepositoryBaseline:
    binding: ProjectRepositoryBindingRecord
    snapshot: RepositorySnapshotRecord


def _repository_source_id(source_id: str) -> str:
    return source_id.split(":", 1)[0]


def _governance_path(source_id: str) -> str | None:
    _, separator, path = source_id.partition(":")
    return path if separator and path else None


def _short_oid(value: str | None) -> str | None:
    return value[:10] if value else None


def _is_reparse_point(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _governance_preferences(prompt: str, scenario: str) -> tuple[str, ...]:
    """Return a deterministic, bounded allowlisted preference order."""

    text = f"{prompt} {scenario}".lower()
    values: list[str] = []

    def add(*paths: str) -> None:
        for path in paths:
            if path not in values:
                values.append(path)

    if any(
        term in text
        for term in (
            "开发",
            "代码",
            "实现",
            "修复",
            "审查",
            "review",
            "implement",
            "develop",
            "code",
        )
    ):
        add("AGENTS.md", "CLAUDE.md", "docs/engineering-standards.md")
    if any(term in text for term in ("状态", "进度", "做到哪", "当前", "status", "progress")):
        add("PROJECT_STATE.md")
    if any(term in text for term in ("计划", "下一步", "路线", "plan", "roadmap", "next")):
        add("PROJECT_PLAN.md")
    if any(term in text for term in ("愿景", "架构", "边界", "定位", "vision", "architecture")):
        add("PROJECT_CONTEXT.md")
    if any(term in text for term in ("复盘", "错误", "教训", "规范", "规则", "lesson", "mistake")):
        add("PROJECT_LESSONS.md")
    if any(term in text for term in ("概览", "介绍", "是什么", "overview", "readme")):
        add("README.md")
    if not values:
        add("README.md")
    return tuple(values)


class RepositoryContextSourceResolver:
    """Resolve only governance documents present in the current Snapshot manifest."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        catalog: WorkspaceRootCatalog,
        scope_id: str = DEFAULT_SCOPE_ID,
        max_document_bytes: int = MAX_GOVERNANCE_DOCUMENT_BYTES,
    ) -> None:
        self._database = database
        self._catalog = catalog
        self._scope_id = scope_id
        self._max_document_bytes = max_document_bytes
        self._allowlisted = {path: kind for path, kind in GOVERNANCE_DOCUMENTS}

    async def materialize(
        self,
        *,
        source_kind: str,
        source_id: str,
        source_revision: str | None,
    ) -> dict[str, Any]:
        """Load one approved governance source without opening a DB transaction."""

        if source_kind not in {"repository_governance", "repository_governance_manifest"}:
            raise ContextSourceStale(
                "该Context来源不能按仓库治理文档解析。",
                reason_code="source_kind_invalid",
            )
        path = _governance_path(source_id)
        if path is None or path not in self._allowlisted:
            raise ContextSourceStale(
                "仓库治理文档不在允许清单中，请重新准备本轮。",
                reason_code="governance_path_not_allowlisted",
            )
        baseline = await self._baseline(
            _repository_source_id(source_id),
            expected_revision=source_revision,
        )
        manifest = {
            str(value.get("path")): value
            for value in baseline.snapshot.governance_manifest_json or []
            if isinstance(value, Mapping)
        }
        entry = manifest.get(path)
        if entry is None:
            raise ContextSourceStale(
                "仓库治理文档已不在当前快照中，请重新准备本轮。",
                reason_code="governance_manifest_changed",
            )
        content = await asyncio.to_thread(
            self._read_document,
            baseline.binding,
            path,
            str(entry.get("sha256") or ""),
            int(entry.get("size_bytes") or 0),
        )
        return {
            "source_kind": "repository_governance",
            "source_id": source_id,
            "source_revision": baseline.snapshot.semantic_hash,
            "title": f"{baseline.binding.display_name} · {path}",
            "content": content,
            "adopted": True,
            "locked": False,
            "selection_origin": "system",
            "reason": "当前意图需要该仓库治理文档，正文Hash已与Repository Snapshot核对",
            "token_estimate": max(1, len(content) // 3),
        }

    async def _baseline(
        self,
        binding_id: str,
        *,
        expected_revision: str | None,
    ) -> _RepositoryBaseline:
        async with self._database.sessions() as transaction:
            binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
            if binding is None or binding.scope_id != self._scope_id:
                raise ContextSourceStale(
                    "仓库绑定已不存在，请重新准备本轮。",
                    reason_code="binding_missing",
                )
            snapshot = await transaction.scalar(
                select(RepositorySnapshotRecord)
                .where(
                    RepositorySnapshotRecord.binding_id == binding.id,
                    RepositorySnapshotRecord.sequence == binding.latest_snapshot_sequence,
                )
                .limit(1)
            )
            self._assert_baseline(binding, snapshot, expected_revision=expected_revision)
            assert snapshot is not None
            return _RepositoryBaseline(binding=binding, snapshot=snapshot)

    @staticmethod
    def _assert_baseline(
        binding: ProjectRepositoryBindingRecord,
        snapshot: RepositorySnapshotRecord | None,
        *,
        expected_revision: str | None,
    ) -> None:
        if snapshot is None or snapshot.capture_status != "available":
            raise ContextSourceStale(
                "仓库最新一次观察不可用，不能回退到旧快照发送。",
                reason_code="latest_snapshot_unavailable",
            )
        if binding.status != "active":
            raise ContextSourceStale(
                "仓库绑定当前不可用，请按最新仓库重新准备。",
                reason_code="binding_not_active",
            )
        if (
            snapshot.binding_generation != binding.generation
            or snapshot.locator_hash != binding.locator_hash
            or snapshot.root_identity_hash != binding.root_identity_hash
        ):
            raise ContextSourceStale(
                "仓库位置或绑定代次已变化，请重新准备本轮。",
                reason_code="binding_generation_changed",
            )
        if not expected_revision or snapshot.semantic_hash != expected_revision:
            raise ContextSourceStale(
                "仓库内容已变化，旧Context不能继续发送。",
                reason_code="semantic_hash_changed",
            )

    def _read_document(
        self,
        binding: ProjectRepositoryBindingRecord,
        relative_path: str,
        expected_sha256: str,
        expected_size: int,
    ) -> str:
        current, metadata = self._resolve_document_path(
            binding,
            relative_path,
            expected_size=expected_size,
        )
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(current, flags)
        except OSError as error:
            raise ContextSourceStale(
                "仓库治理文档无法安全打开，请刷新仓库。",
                reason_code="governance_document_unavailable",
            ) from error
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
            ):
                raise ContextSourceStale(
                    "仓库治理文档在读取期间变化，请刷新仓库。",
                    reason_code="governance_document_raced",
                )
            with os.fdopen(descriptor, "rb", closefd=True) as stream:
                descriptor = -1
                payload = stream.read(self._max_document_bytes + 1)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        if len(payload) != expected_size or hashlib.sha256(payload).hexdigest() != expected_sha256:
            raise ContextSourceStale(
                "仓库治理文档Hash与快照不一致，请刷新仓库。",
                reason_code="governance_document_hash_changed",
            )
        try:
            return payload.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ContextSourceStale(
                "仓库治理文档不再是UTF-8文本，请刷新仓库。",
                reason_code="governance_document_encoding_changed",
            ) from error

    def _resolve_document_path(
        self,
        binding: ProjectRepositoryBindingRecord,
        relative_path: str,
        *,
        expected_size: int,
    ) -> tuple[Path, os.stat_result]:
        """Resolve every segment and retain metadata for the open/fstat race check."""

        try:
            root = self._catalog.require_available(binding.root_key)
            repository = resolve_repository_path(root, binding.relative_path)
        except ProjectResourceError as error:
            raise ContextSourceStale(
                "仓库位置当前无法安全读取，请刷新仓库。",
                reason_code=error.code.lower(),
            ) from error
        if root.identity_hash != binding.root_identity_hash:
            raise ContextSourceStale(
                "Workspace Root身份已变化，请重新准备本轮。",
                reason_code="root_identity_changed",
            )
        if repository.locator_hash != binding.locator_hash:
            raise ContextSourceStale(
                "仓库位置已变化，请重新准备本轮。",
                reason_code="locator_changed",
            )
        current = repository.absolute_path
        metadata: os.stat_result | None = None
        for segment in relative_path.split("/"):
            current = current / segment
            try:
                metadata = current.lstat()
            except OSError as error:
                raise ContextSourceStale(
                    "仓库治理文档已变化或不可读取，请刷新仓库。",
                    reason_code="governance_document_unavailable",
                ) from error
            if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata):
                raise ContextSourceStale(
                    "仓库治理文档路径不能经过链接，请刷新仓库。",
                    reason_code="governance_symlink_rejected",
                )
        if metadata is None or not stat.S_ISREG(metadata.st_mode):
            raise ContextSourceStale(
                "仓库治理文档不再是普通文件，请刷新仓库。",
                reason_code="governance_document_invalid",
            )
        if (
            metadata.st_size > self._max_document_bytes
            or metadata.st_size != expected_size
            or expected_size < 0
        ):
            raise ContextSourceStale(
                "仓库治理文档大小已变化，请刷新仓库。",
                reason_code="governance_document_size_changed",
            )
        return current, metadata


class RepositoryContextContributor:
    """Add bounded repository facts to the two-stage Harness Context."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        catalog: WorkspaceRootCatalog,
        scope_id: str = DEFAULT_SCOPE_ID,
        max_default_documents: int = MAX_DEFAULT_GOVERNANCE_DOCUMENTS,
        max_governance_context_bytes: int = MAX_GOVERNANCE_CONTEXT_BYTES,
    ) -> None:
        self._queries = ProjectResourceQueryService(database, scope_id=scope_id)
        self._resolver = RepositoryContextSourceResolver(
            database,
            catalog=catalog,
            scope_id=scope_id,
        )
        self._max_default_documents = max_default_documents
        self._max_governance_context_bytes = max_governance_context_bytes

    async def directory_context_items(
        self,
        *,
        prompt: str,
        projects: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        del prompt
        items: list[dict[str, Any]] = []
        for project in projects:
            project_id = str(project.get("id") or "")
            if not project_id:
                continue
            summaries = await self._queries.list_summaries(project_id=project_id)
            for value in sorted(summaries, key=self._summary_order):
                binding = value["binding"]
                snapshot = value.get("latest_snapshot")
                snapshot_view = snapshot if isinstance(snapshot, Mapping) else {}
                available = (
                    binding["status"] == "active" and snapshot_view.get("capture_status") == "available"
                )
                revision = str(snapshot_view.get("semantic_hash")) if available else None
                items.append(
                    {
                        "source_kind": "repository_directory",
                        "source_id": binding["id"],
                        "source_revision": revision,
                        "title": f"{project.get('title') or 'Project'} · {binding['display_name']}",
                        "content": canonical_json(
                            {
                                "display_name": binding["display_name"],
                                "role": binding["role"],
                                "status": binding["status"],
                                "head_ref": snapshot_view.get("head_ref"),
                                "head_short": _short_oid(snapshot_view.get("head_oid")),
                                "dirty": bool(snapshot_view.get("dirty")) if snapshot_view else None,
                            }
                        ),
                        "adopted": available,
                        "reason": (
                            "正式Project绑定的当前可用仓库轻量目录；不读取文件正文"
                            if available
                            else "仓库最新观察不可用或已解除，本轮不自动采用"
                        ),
                    }
                )
        logger.info(
            "repository_context_directory_assembled projects=%d sources=%d adopted=%d",
            len(projects),
            len(items),
            sum(bool(value["adopted"]) for value in items),
        )
        return items

    async def detailed_context_items(
        self,
        *,
        project_id: str,
        prompt: str,
        scenario: str,
    ) -> list[dict[str, Any]]:
        summaries = sorted(
            await self._queries.list_summaries(project_id=project_id),
            key=self._summary_order,
        )
        items: list[dict[str, Any]] = []
        available = [
            value
            for value in summaries
            if value["binding"]["status"] == "active"
            and isinstance(value.get("latest_snapshot"), Mapping)
            and value["latest_snapshot"].get("capture_status") == "available"
        ]
        default_binding_id = available[0]["binding"]["id"] if available else None
        for value in summaries:
            binding = value["binding"]
            snapshot = value.get("latest_snapshot")
            snapshot_view = snapshot if isinstance(snapshot, Mapping) else {}
            is_available = value in available
            adopted = is_available and binding["id"] == default_binding_id
            items.append(
                {
                    "source_kind": "repository_snapshot",
                    "source_id": binding["id"],
                    "source_revision": snapshot_view.get("semantic_hash") if is_available else None,
                    "title": f"{binding['display_name']} · Repository Snapshot",
                    "content": canonical_json(
                        {
                            "role": binding["role"],
                            "status": binding["status"],
                            "generation": binding["generation"],
                            "head_ref": snapshot_view.get("head_ref"),
                            "head_short": _short_oid(snapshot_view.get("head_oid")),
                            "dirty": bool(snapshot_view.get("dirty")) if snapshot_view else None,
                            "ahead_count": snapshot_view.get("ahead_count"),
                            "behind_count": snapshot_view.get("behind_count"),
                            "change_count": snapshot_view.get("change_count"),
                            "fingerprint_complete": snapshot_view.get("fingerprint_complete"),
                        }
                    ),
                    "adopted": adopted,
                    "reason": (
                        "选定Project的默认代码基线"
                        if adopted
                        else (
                            "同一Project的补充仓库；默认不扩大本轮Context"
                            if is_available
                            else "最新仓库观察不可用，本轮不自动采用旧成功快照"
                        )
                    ),
                }
            )
        if available:
            items.extend(
                await self._governance_items(
                    available[0],
                    prompt=prompt,
                    scenario=scenario,
                )
            )
        logger.info(
            "repository_context_detail_assembled project_id=%s bindings=%d sources=%d adopted=%d",
            project_id,
            len(summaries),
            len(items),
            sum(bool(value["adopted"]) for value in items),
        )
        return items

    async def _governance_items(
        self,
        summary: Mapping[str, Any],
        *,
        prompt: str,
        scenario: str,
    ) -> list[dict[str, Any]]:
        binding = summary["binding"]
        snapshot = summary["latest_snapshot"]
        revision = str(snapshot["semantic_hash"])
        manifest = [
            dict(value) for value in snapshot.get("governance_manifest") or [] if isinstance(value, Mapping)
        ]
        by_path = {str(value.get("path")): value for value in manifest}
        preferred = [path for path in _governance_preferences(prompt, scenario) if path in by_path][
            : self._max_default_documents
        ]
        selected_paths: set[str] = set()
        remaining_bytes = self._max_governance_context_bytes
        for path in preferred:
            size_bytes = int(by_path[path].get("size_bytes") or 0)
            if 0 <= size_bytes <= remaining_bytes:
                selected_paths.add(path)
                remaining_bytes -= size_bytes
        items: list[dict[str, Any]] = []
        for entry in manifest:
            path = str(entry.get("path") or "")
            selected = path in selected_paths
            source_id = f"{binding['id']}:{path}"
            if selected:
                items.append(
                    await self._resolver.materialize(
                        source_kind="repository_governance",
                        source_id=source_id,
                        source_revision=revision,
                    )
                )
                continue
            is_candidate = path in preferred
            items.append(
                {
                    "source_kind": "repository_governance_manifest",
                    "source_id": source_id,
                    "source_revision": revision,
                    "title": f"{binding['display_name']} · {path}",
                    "content": canonical_json(
                        {
                            "path": path,
                            "kind": entry.get("kind"),
                            "sha256": entry.get("sha256"),
                            "size_bytes": entry.get("size_bytes"),
                            "body_loaded": False,
                        }
                    ),
                    "adopted": False,
                    "reason": (
                        "默认候选正文超过本轮剩余预算；先展示Manifest，需由用户选择载入"
                        if is_candidate
                        else "当前意图未默认选择该治理文档；可在Context工作台按需载入"
                    ),
                }
            )
        return items

    @staticmethod
    def _summary_order(value: Mapping[str, Any]) -> tuple[int, str]:
        role_rank = {"primary": 0, "supporting": 1, "documentation": 2}
        binding = value["binding"]
        return role_rank.get(str(binding.get("role")), 9), str(binding.get("display_name") or "")


class RepositorySourceFreshnessGuard:
    """Validate every adopted repository source against the latest observation."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = DEFAULT_SCOPE_ID,
    ) -> None:
        self._database = database
        self._scope_id = scope_id

    async def assert_package_fresh(self, package_id: str | None) -> dict[str, Any]:
        if not package_id:
            return {"fresh": True, "context_package_id": None, "sources": []}
        async with self._database.sessions() as transaction:
            package = await transaction.get(ContextPackageRecord, package_id)
            if package is None or package.scope_id != self._scope_id:
                raise ContextSourceStale(
                    "本轮Context已不存在，请重新准备。",
                    reason_code="context_package_missing",
                )
            if package.status == "superseded":
                raise ContextSourceStale(
                    "本轮Context已产生新版本，请按最新内容重新准备。",
                    reason_code="context_package_superseded",
                )
            records = list(
                (
                    await transaction.scalars(
                        select(ContextAdoptionRecord)
                        .where(
                            ContextAdoptionRecord.context_package_id == package.id,
                            ContextAdoptionRecord.adopted.is_(True),
                        )
                        .order_by(ContextAdoptionRecord.ordinal)
                    )
                ).all()
            )
            items = [
                {
                    "source_kind": value.source_kind,
                    "source_id": value.source_id,
                    "source_revision": value.source_revision,
                }
                for value in records
            ]
        report = await self.assert_items_fresh(items)
        return {
            **report,
            "context_package_id": package_id,
            "context_package_hash": package.package_hash,
        }

    async def assert_items_fresh(
        self,
        items: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        expected: dict[str, str] = {}
        source_kinds: dict[str, set[str]] = {}
        for item in items:
            source_kind = str(item.get("source_kind") or "")
            source_id = str(item.get("source_id") or "")
            if source_kind not in REPOSITORY_SOURCE_KINDS and source_kind != "user_override":
                continue
            binding_id = _repository_source_id(source_id)
            revision = str(item.get("source_revision") or "")
            if not binding_id or not revision:
                if source_kind in REPOSITORY_SOURCE_KINDS:
                    raise ContextSourceStale(
                        "仓库Context缺少可验证版本，请重新准备。",
                        reason_code="source_revision_missing",
                    )
                continue
            previous = expected.setdefault(binding_id, revision)
            if previous != revision:
                raise ContextSourceStale(
                    "同一仓库在本轮Context中引用了不同版本，请重新准备。",
                    reason_code="source_revision_conflict",
                )
            source_kinds.setdefault(binding_id, set()).add(source_kind)
        if not expected:
            return {"fresh": True, "sources": []}

        sources: list[dict[str, Any]] = []
        async with self._database.sessions() as transaction:
            for binding_id, revision in expected.items():
                binding = await transaction.get(ProjectRepositoryBindingRecord, binding_id)
                if binding is None:
                    # A user_override from a non-repository source may happen to
                    # contain a colon.  It must not be promoted to repository
                    # provenance merely by string shape.
                    if source_kinds[binding_id] == {"user_override"}:
                        continue
                    raise ContextSourceStale(
                        "仓库绑定已不存在，请重新准备。",
                        reason_code="binding_missing",
                    )
                if binding.scope_id != self._scope_id:
                    raise ContextSourceStale(
                        "仓库绑定不属于当前作用域。",
                        reason_code="binding_scope_mismatch",
                    )
                snapshot = await transaction.scalar(
                    select(RepositorySnapshotRecord)
                    .where(
                        RepositorySnapshotRecord.binding_id == binding.id,
                        RepositorySnapshotRecord.sequence == binding.latest_snapshot_sequence,
                    )
                    .limit(1)
                )
                RepositoryContextSourceResolver._assert_baseline(
                    binding,
                    snapshot,
                    expected_revision=revision,
                )
                assert snapshot is not None
                sources.append(
                    {
                        "binding_id": binding.id,
                        "display_name": binding.display_name,
                        "semantic_hash": snapshot.semantic_hash,
                        "generation": binding.generation,
                        "snapshot_sequence": snapshot.sequence,
                        "source_kinds": sorted(source_kinds[binding_id]),
                    }
                )
        logger.info(
            "repository_context_freshness_checked sources=%d result=fresh",
            len(sources),
        )
        return {"fresh": True, "sources": sources}

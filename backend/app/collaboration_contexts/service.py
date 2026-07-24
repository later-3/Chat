"""Atomic user revision of selected context and dependent authorization state."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Mapping, Protocol, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..collaboration_protocols.models import CollaborationProtocolRuleRecord
from ..governance.models import (
    AuthorizationGrantRecord,
    ExecutionDraftRecord,
    ExecutionDraftRevisionRecord,
    HumanDecisionRequestItemRecord,
    HumanDecisionRequestRecord,
    RunSpecRecord,
    RuntimeInterruptLinkRecord,
    TurnSummaryRecord,
)
from ..harness.commands import HarnessCommandRecorder
from ..harness.contracts import (
    HarnessConflict,
    HarnessNotFound,
    HarnessValidationError,
    content_hash,
    context_package_hash,
    new_id,
    normalized_text,
)
from ..harness.models import (
    AcceptedMemoryRecord,
    ContextAdoptionRecord,
    ContextPackageRecord,
    MemoryRevisionRecord,
    NoteRecord,
    NoteRevisionRecord,
    ProductProjectRecord,
    WorkItemRecord,
)
from ..observability.context import bind_context
from ..product_sessions.database import ProductDatabase, RunRecord, utc_now
from ..product_sessions.service import DEFAULT_SCOPE_ID

logger = logging.getLogger(__name__)


class ExternalContextSourceResolver(Protocol):
    """Resolve an allowlisted external source outside the product transaction."""

    async def materialize(
        self,
        *,
        source_kind: str,
        source_id: str,
        source_revision: str | None,
    ) -> dict[str, Any]: ...


class CollaborationContextService:
    """Own one Context revision transaction across Harness and Governance."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = DEFAULT_SCOPE_ID,
        principal_id: str = "local-user",
        clock: Callable[[], datetime] = utc_now,
        external_source_resolver: ExternalContextSourceResolver | None = None,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock
        self._external_source_resolver = external_source_resolver
        self._commands = HarnessCommandRecorder(
            scope_id=scope_id,
            principal_id=principal_id,
            clock=clock,
        )

    async def revise_package(
        self,
        *,
        package_id: str,
        command_id: str,
        expected_package_hash: str,
        reason: str,
        item_changes: Sequence[Mapping[str, Any]] = (),
        added_source_refs: Sequence[Mapping[str, Any]] = (),
        token_budget: int | None = None,
    ) -> dict[str, Any]:
        """Create a new immutable revision and invalidate stale authorization.

        The currently sent/finished execution cannot be retroactively changed.
        If a RunSpec has already been bound, the command fails closed.
        """

        revision_reason = normalized_text(reason, field="修改原因", max_length=1000)
        request = {
            "package_id": package_id,
            "expected_package_hash": expected_package_hash,
            "reason": revision_reason,
            "item_changes": [dict(value) for value in item_changes],
            "added_source_refs": [dict(value) for value in added_source_refs],
            "token_budget": token_budget,
        }
        request_hash = content_hash(request)
        # Preserve command idempotency even when the referenced external source
        # has changed since the first successful command. A replay returns the
        # immutable recorded result and must not touch the filesystem again.
        async with self.database.sessions() as transaction:
            replay = await self._commands.existing(
                transaction,
                command_id,
                request_hash,
            )
            if replay is not None:
                return replay
        materialized_items = await self._materialize_item_changes(
            package_id=package_id,
            expected_package_hash=expected_package_hash,
            item_changes=item_changes,
        )
        async with self.database.sessions.begin() as transaction:
            replay = await self._commands.existing(
                transaction,
                command_id,
                request_hash,
            )
            if replay is not None:
                return replay
            current = await transaction.get(ContextPackageRecord, package_id)
            if current is None or current.scope_id != self.scope_id:
                raise HarnessNotFound("ContextPackage不存在")
            if current.package_hash != expected_package_hash:
                raise HarnessConflict("ContextPackage已变化，请重新加载后再修改")
            if current.status == "superseded":
                raise HarnessConflict("ContextPackage revision已被后续版本取代")
            run = await transaction.get(RunRecord, current.run_id)
            if run is None:
                raise HarnessNotFound("ContextPackage关联的Product Run不存在")
            await self._assert_execution_not_started(transaction, run)

            old_items = list(
                (
                    await transaction.scalars(
                        select(ContextAdoptionRecord)
                        .where(ContextAdoptionRecord.context_package_id == current.id)
                        .order_by(ContextAdoptionRecord.ordinal)
                    )
                ).all()
            )
            normalized = await self._revise_items(
                transaction,
                old_items=old_items,
                item_changes=item_changes,
                added_source_refs=added_source_refs,
                materialized_items=materialized_items,
            )
            effective_budget = token_budget if token_budget is not None else current.token_budget
            if effective_budget < 128 or effective_budget > 200_000:
                raise HarnessValidationError("Context Token预算必须在128到200000之间")
            estimated_tokens = sum(int(value["token_estimate"]) for value in normalized if value["adopted"])
            if estimated_tokens > effective_budget:
                raise HarnessValidationError(
                    f"已采用Context预计{estimated_tokens} Tokens，超过预算{effective_budget}"
                )
            revision = (
                int(
                    await transaction.scalar(
                        select(func.max(ContextPackageRecord.revision)).where(
                            ContextPackageRecord.run_id == current.run_id,
                            ContextPackageRecord.stage == current.stage,
                        )
                    )
                    or 0
                )
                + 1
            )
            package_hash = context_package_hash(
                stage=current.stage,
                selected_project_id=current.selected_project_id,
                selected_work_item_id=current.selected_work_item_id,
                token_budget=effective_budget,
                items=normalized,
            )
            if package_hash == current.package_hash:
                raise HarnessValidationError("Context没有发生变化，无需创建新revision")

            now = self._clock()
            package = ContextPackageRecord(
                id=new_id(),
                scope_id=self.scope_id,
                session_id=current.session_id,
                interaction_id=current.interaction_id,
                run_id=current.run_id,
                stage=current.stage,
                revision=revision,
                previous_package_id=current.id,
                selected_project_id=current.selected_project_id,
                selected_work_item_id=current.selected_work_item_id,
                token_budget=effective_budget,
                estimated_tokens=estimated_tokens,
                package_hash=package_hash,
                status="adopted" if current.stage == "detail" else "candidate",
                revision_reason=revision_reason,
                created_by=self.principal_id,
                created_at=now,
            )
            current.status = "superseded"
            transaction.add(package)
            await transaction.flush()
            for item in normalized:
                transaction.add(
                    ContextAdoptionRecord(
                        id=new_id(),
                        context_package_id=package.id,
                        ordinal=item["ordinal"],
                        source_kind=item["source_kind"],
                        source_id=item["source_id"],
                        source_revision=item.get("source_revision"),
                        title=item["title"],
                        content_text=item["content"],
                        adopted=item["adopted"],
                        locked=item["locked"],
                        selection_origin=item["selection_origin"],
                        reason=item["reason"],
                        token_estimate=item["token_estimate"],
                    )
                )
            invalidation = await self._invalidate_dependent_execution(
                transaction,
                run=run,
                old_package_id=current.id,
                now=now,
            )
            result = {
                **await self._package_view(
                    transaction,
                    package,
                    pending_items=normalized,
                ),
                "previous_package_hash": current.package_hash,
                "execution_invalidation": invalidation,
            }
            self._commands.record(
                transaction,
                command_id=command_id,
                command_kind="revise_context_package",
                request_hash=request_hash,
                result=result,
                resource_kind="context_package",
                resource_id=package.id,
                event_type="harness.context.revised",
                trace_payload={
                    "previous_package_id": current.id,
                    "previous_package_hash": current.package_hash,
                    "revision": revision,
                    "package_hash": package_hash,
                    "adopted_count": sum(value["adopted"] for value in normalized),
                    "excluded_count": sum(not value["adopted"] for value in normalized),
                    "locked_count": sum(value["locked"] for value in normalized),
                    "estimated_tokens": estimated_tokens,
                    "token_budget": effective_budget,
                    "execution_invalidated": invalidation["invalidated"],
                },
            )
        with bind_context(
            session_id=current.session_id,
            product_run_id=current.run_id,
            resource_id=package.id,
            command_id=command_id,
        ):
            logger.info(
                "context_package_revised revision=%d adopted=%d excluded=%d locked=%d "
                "execution_invalidated=%s",
                revision,
                sum(value["adopted"] for value in normalized),
                sum(not value["adopted"] for value in normalized),
                sum(value["locked"] for value in normalized),
                invalidation["invalidated"],
            )
        return result

    async def _revise_items(
        self,
        transaction: AsyncSession,
        *,
        old_items: Sequence[ContextAdoptionRecord],
        item_changes: Sequence[Mapping[str, Any]],
        added_source_refs: Sequence[Mapping[str, Any]],
        materialized_items: Mapping[int, Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        by_ordinal = {value.ordinal: value for value in old_items}
        changes: dict[int, Mapping[str, Any]] = {}
        for raw in item_changes:
            if "ordinal" not in raw:
                raise HarnessValidationError("Context item change缺少ordinal")
            ordinal = int(raw["ordinal"])
            if ordinal not in by_ordinal:
                raise HarnessValidationError(f"Context item ordinal {ordinal}不存在")
            if ordinal in changes:
                raise HarnessValidationError(f"Context item ordinal {ordinal}重复修改")
            changes[ordinal] = raw

        result: list[dict[str, Any]] = []
        for old in old_items:
            change = changes.get(old.ordinal, {})
            materialized = materialized_items.get(old.ordinal)
            if materialized is not None:
                content_override = str(materialized.get("content") or "").strip()
                source_kind = str(materialized.get("source_kind") or old.source_kind)
                title = str(materialized.get("title") or old.title)
            else:
                content_override = str(change["content"]).strip() if "content" in change else old.content_text
                source_kind = old.source_kind
                title = old.title
            if not content_override:
                raise HarnessValidationError("Context内容不能为空")
            overridden = materialized is None and content_override != old.content_text
            locked = bool(change.get("locked", old.locked))
            adopted = bool(change.get("adopted", old.adopted)) or locked
            result.append(
                {
                    "ordinal": len(result),
                    "source_kind": "user_override" if overridden else source_kind,
                    "source_id": old.source_id,
                    "source_revision": old.source_revision,
                    "title": title,
                    "content": content_override,
                    "adopted": adopted,
                    "locked": locked,
                    "selection_origin": ("human" if change else old.selection_origin),
                    "reason": str(
                        change.get("reason")
                        or (
                            "用户选择载入并采用仓库治理正文"
                            if materialized is not None
                            else ("用户修改本轮采用内容" if overridden else old.reason)
                        )
                    )[:1000],
                    "token_estimate": max(1, len(content_override) // 3),
                }
            )
        for source_ref in added_source_refs:
            resolved = await self._resolve_source_ref(transaction, source_ref)
            resolved["ordinal"] = len(result)
            result.append(resolved)
        return result

    async def _materialize_item_changes(
        self,
        *,
        package_id: str,
        expected_package_hash: str,
        item_changes: Sequence[Mapping[str, Any]],
    ) -> dict[int, Mapping[str, Any]]:
        requested = {
            int(value["ordinal"])
            for value in item_changes
            if value.get("materialize") is True and "ordinal" in value
        }
        if not requested:
            return {}
        if self._external_source_resolver is None:
            raise HarnessValidationError("当前没有可用的外部Context来源解析器")
        async with self.database.sessions() as transaction:
            package = await transaction.get(ContextPackageRecord, package_id)
            if package is None or package.scope_id != self.scope_id:
                raise HarnessNotFound("ContextPackage不存在")
            if package.package_hash != expected_package_hash or package.status == "superseded":
                raise HarnessConflict("ContextPackage已变化，请重新加载后再修改")
            records = list(
                (
                    await transaction.scalars(
                        select(ContextAdoptionRecord).where(
                            ContextAdoptionRecord.context_package_id == package.id
                        )
                    )
                ).all()
            )
        by_ordinal = {value.ordinal: value for value in records}
        unknown = requested - set(by_ordinal)
        if unknown:
            raise HarnessValidationError(f"Context item ordinal {min(unknown)}不存在")
        resolved: dict[int, Mapping[str, Any]] = {}
        for ordinal in sorted(requested):
            source = by_ordinal[ordinal]
            resolved[ordinal] = await self._external_source_resolver.materialize(
                source_kind=source.source_kind,
                source_id=source.source_id,
                source_revision=source.source_revision,
            )
        return resolved

    async def _resolve_source_ref(
        self,
        transaction: AsyncSession,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        source_kind = str(raw.get("source_kind") or "").strip()
        source_id = str(raw.get("source_id") or "").strip()
        reason = str(raw.get("reason") or "用户从信息面板加入本轮Context").strip()[:1000]
        if not source_kind or not source_id:
            raise HarnessValidationError("新增Context来源必须包含source_kind和source_id")
        title = ""
        content = ""
        revision: str | None = None
        if source_kind == "project":
            value = await transaction.get(ProductProjectRecord, source_id)
            if value is None or value.scope_id != self.scope_id:
                raise HarnessNotFound("新增Context引用的Project不存在")
            title, content, revision = value.title, value.goal, str(value.row_version)
        elif source_kind == "work_item":
            value = await transaction.get(WorkItemRecord, source_id)
            if value is None or value.scope_id != self.scope_id:
                raise HarnessNotFound("新增Context引用的Work不存在")
            title, content, revision = value.title, value.objective, str(value.row_version)
        elif source_kind == "note":
            value = await transaction.get(NoteRecord, source_id)
            if value is None or value.scope_id != self.scope_id or not value.current_revision_id:
                raise HarnessNotFound("新增Context引用的Note不存在")
            note_revision = await transaction.get(
                NoteRevisionRecord,
                value.current_revision_id,
            )
            if note_revision is None:
                raise HarnessConflict("Note当前revision引用损坏")
            title, content, revision = value.title, note_revision.content, str(note_revision.revision)
        elif source_kind == "accepted_memory":
            value = await transaction.get(AcceptedMemoryRecord, source_id)
            if value is None or value.scope_id != self.scope_id or not value.current_revision_id:
                raise HarnessNotFound("新增Context引用的Memory不存在")
            memory_revision = await transaction.get(
                MemoryRevisionRecord,
                value.current_revision_id,
            )
            if memory_revision is None:
                raise HarnessConflict("Memory当前revision引用损坏")
            title = f"已接受Memory · {value.memory_kind}"
            content, revision = memory_revision.content, str(memory_revision.revision)
        elif source_kind == "turn_digest":
            value = await transaction.get(TurnSummaryRecord, source_id)
            if value is None:
                raise HarnessNotFound("新增Context引用的TurnDigest不存在")
            title = value.topic
            content = str(value.summary_json)
            revision = value.summary_hash
        elif source_kind == "protocol_rule":
            value = await transaction.get(CollaborationProtocolRuleRecord, source_id)
            if value is None:
                raise HarnessNotFound("新增Context引用的协议规则不存在")
            title, content = value.name, value.description
            revision = str(value.ordinal)
        else:
            raise HarnessValidationError(f"暂不支持的Context来源类型：{source_kind}")
        return {
            "source_kind": source_kind,
            "source_id": source_id,
            "source_revision": revision,
            "title": title,
            "content": content,
            "adopted": bool(raw.get("adopted", True)),
            "locked": bool(raw.get("locked", False)),
            "selection_origin": "human",
            "reason": reason,
            "token_estimate": max(1, len(content) // 3),
        }

    @staticmethod
    async def _assert_execution_not_started(
        transaction: AsyncSession,
        run: RunRecord,
    ) -> None:
        bound = await transaction.scalar(
            select(RunSpecRecord).where(
                RunSpecRecord.bound_run_id == run.id,
                RunSpecRecord.status == "bound",
            )
        )
        if bound is not None:
            raise HarnessConflict("本轮RunSpec已经绑定，不能追溯修改Context；请停止后基于新Context重新运行")

    async def _invalidate_dependent_execution(
        self,
        transaction: AsyncSession,
        *,
        run: RunRecord,
        old_package_id: str,
        now: datetime,
    ) -> dict[str, Any]:
        drafts = list(
            (
                await transaction.scalars(
                    select(ExecutionDraftRecord).where(
                        ExecutionDraftRecord.interaction_id == run.interaction_id
                    )
                )
            ).all()
        )
        invalidated_drafts: list[str] = []
        invalidated_requests: set[str] = set()
        for draft in drafts:
            if not draft.current_revision_id:
                continue
            revision = await transaction.get(
                ExecutionDraftRevisionRecord,
                draft.current_revision_id,
            )
            if revision is None:
                raise HarnessConflict("ExecutionDraft当前revision引用损坏")
            binding = dict(revision.payload_json or {}).get("context_binding") or {}
            if binding.get("context_package_id") != old_package_id:
                continue
            if revision.status in {"reviewable", "accepted"}:
                revision.status = "superseded"
            draft.status = "invalidated"
            draft.accepted_revision_id = None
            draft.acceptance_decision_record_id = None
            draft.row_version += 1
            draft.updated_at = now
            invalidated_drafts.append(draft.id)
            grants = list(
                (
                    await transaction.scalars(
                        select(AuthorizationGrantRecord).where(
                            AuthorizationGrantRecord.subject_id == revision.subject_id,
                            AuthorizationGrantRecord.status == "active",
                        )
                    )
                ).all()
            )
            for grant in grants:
                grant.status = "invalidated"
                grant.invalidated_at = now
                grant.invalidation_reason = "context_revision_changed"
                grant.row_version += 1
            items = list(
                (
                    await transaction.scalars(
                        select(HumanDecisionRequestItemRecord).where(
                            HumanDecisionRequestItemRecord.subject_id == revision.subject_id,
                            HumanDecisionRequestItemRecord.status == "pending",
                        )
                    )
                ).all()
            )
            for item in items:
                item.status = "superseded"
                invalidated_requests.add(item.request_id)
        for request_id in invalidated_requests:
            request = await transaction.get(HumanDecisionRequestRecord, request_id)
            if request is not None and request.status == "pending":
                request.status = "superseded"
                request.row_version += 1
                request.resolved_at = now
            link = await transaction.scalar(
                select(RuntimeInterruptLinkRecord).where(
                    RuntimeInterruptLinkRecord.decision_request_id == request_id
                )
            )
            if link is not None and link.status not in {"resumed", "closed"}:
                link.status = "recovery_required"
                link.last_error_code = "context_revision_changed"
                link.updated_at = now
        return {
            "invalidated": bool(invalidated_drafts),
            "draft_ids": invalidated_drafts,
            "decision_request_ids": sorted(invalidated_requests),
            "requires_recompile": bool(invalidated_drafts),
        }

    async def _package_view(
        self,
        transaction: AsyncSession,
        package: ContextPackageRecord,
        *,
        pending_items: Sequence[Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if pending_items is None:
            records = list(
                (
                    await transaction.scalars(
                        select(ContextAdoptionRecord)
                        .where(ContextAdoptionRecord.context_package_id == package.id)
                        .order_by(ContextAdoptionRecord.ordinal)
                    )
                ).all()
            )
            items = [
                {
                    "ordinal": value.ordinal,
                    "source_kind": value.source_kind,
                    "source_id": value.source_id,
                    "source_revision": value.source_revision,
                    "title": value.title,
                    "content": value.content_text,
                    "adopted": value.adopted,
                    "locked": value.locked,
                    "selection_origin": value.selection_origin,
                    "reason": value.reason,
                    "token_estimate": value.token_estimate,
                }
                for value in records
            ]
        else:
            items = [dict(value) for value in pending_items]
        return {
            "id": package.id,
            "session_id": package.session_id,
            "run_id": package.run_id,
            "stage": package.stage,
            "revision": package.revision,
            "previous_package_id": package.previous_package_id,
            "selected_project_id": package.selected_project_id,
            "selected_work_item_id": package.selected_work_item_id,
            "token_budget": package.token_budget,
            "estimated_tokens": package.estimated_tokens,
            "package_hash": package.package_hash,
            "status": package.status,
            "revision_reason": package.revision_reason,
            "created_by": package.created_by,
            "created_at": package.created_at.isoformat(),
            "items": items,
        }

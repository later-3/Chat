"""Application service for revisioned Intent Sets and clarification answers."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Mapping, Sequence

from sqlalchemy import func, select

from ..governance.models import RunSpecRecord
from ..harness.contracts import (
    HarnessConflict,
    HarnessNotFound,
    HarnessValidationError,
    content_hash,
    new_id,
    normalized_text,
)
from ..harness.models import ProductProjectRecord
from ..observability.context import bind_context
from ..product_sessions.database import ProductDatabase, RunRecord, utc_now
from ..product_sessions.service import DEFAULT_SCOPE_ID
from .models import (
    ClarificationAnswerRecord,
    ClarificationRequestRecord,
    CollaborationIntentRecord,
    CollaborationIntentRevisionRecord,
    CollaborationIntentSetRecord,
    CollaborationIntentSetRevisionRecord,
)

logger = logging.getLogger(__name__)

SUPPORTED_SCENARIOS = {
    "simple_question",
    "continue_project",
    "new_task",
    "plan_request",
    "learning",
    "clarify",
}
SUPPORTED_COMBINATION_POLICIES = {"sequential", "parallel_safe", "single"}
MAX_INTENTS_PER_TURN = 4


class CollaborationIntentService:
    """Own Intent aggregate transactions and cross-Run clarification recovery."""

    def __init__(
        self,
        database: ProductDatabase,
        *,
        scope_id: str = DEFAULT_SCOPE_ID,
        principal_id: str = "local-user",
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self.database = database
        self.scope_id = scope_id
        self.principal_id = principal_id
        self._clock = clock

    async def record_candidate(
        self,
        *,
        run_id: str,
        origin_prompt: str,
        intents: Sequence[Mapping[str, Any]],
        source_model_call_revision_id: str | None,
        author_kind: str = "agent",
        combination_policy: str | None = None,
    ) -> dict[str, Any]:
        """Persist one idempotent candidate snapshot for a Product Run."""

        prompt = normalized_text(origin_prompt, field="origin_prompt", max_length=20_000)
        normalized = self._normalize_intents(intents)
        policy = combination_policy or ("single" if len(normalized) == 1 else "sequential")
        if policy not in SUPPORTED_COMBINATION_POLICIES:
            raise HarnessValidationError("Intent组合策略无效")
        async with self.database.sessions.begin() as transaction:
            run = await transaction.get(RunRecord, run_id)
            if run is None:
                raise HarnessNotFound("Intent Set关联的Product Run不存在")
            root = await transaction.scalar(
                select(CollaborationIntentSetRecord).where(CollaborationIntentSetRecord.run_id == run_id)
            )
            now = self._clock()
            if root is None:
                root = CollaborationIntentSetRecord(
                    id=new_id(),
                    scope_id=self.scope_id,
                    session_id=run.session_id,
                    interaction_id=run.interaction_id,
                    run_id=run.id,
                    status="candidate",
                    row_version=1,
                    created_by=author_kind,
                    created_at=now,
                    updated_at=now,
                )
                transaction.add(root)
                await transaction.flush()

            existing_branches = {
                value.branch_key: value
                for value in (
                    await transaction.scalars(
                        select(CollaborationIntentRecord).where(
                            CollaborationIntentRecord.intent_set_id == root.id
                        )
                    )
                ).all()
            }
            intent_revisions: list[CollaborationIntentRevisionRecord] = []
            for ordinal, payload in enumerate(normalized):
                branch_key = str(payload["branch_key"])
                branch = existing_branches.get(branch_key)
                if branch is None:
                    branch = CollaborationIntentRecord(
                        id=new_id(),
                        intent_set_id=root.id,
                        branch_key=branch_key,
                        ordinal=ordinal,
                        status="candidate",
                        row_version=1,
                        created_at=now,
                        updated_at=now,
                    )
                    transaction.add(branch)
                    await transaction.flush()
                elif branch.ordinal != ordinal:
                    branch.ordinal = ordinal
                    branch.row_version += 1
                    branch.updated_at = now
                current = (
                    await transaction.get(
                        CollaborationIntentRevisionRecord,
                        branch.current_revision_id,
                    )
                    if branch.current_revision_id
                    else None
                )
                semantic = self._semantic_payload(payload)
                revision_hash = content_hash(semantic)
                if current is not None and current.revision_hash == revision_hash:
                    revision = current
                else:
                    revision_number = (
                        int(
                            await transaction.scalar(
                                select(func.max(CollaborationIntentRevisionRecord.revision)).where(
                                    CollaborationIntentRevisionRecord.intent_id == branch.id
                                )
                            )
                            or 0
                        )
                        + 1
                    )
                    if current is not None and current.status == "candidate":
                        current.status = "superseded"
                    revision = CollaborationIntentRevisionRecord(
                        id=new_id(),
                        intent_id=branch.id,
                        revision=revision_number,
                        previous_revision_id=current.id if current else None,
                        source_model_call_revision_id=source_model_call_revision_id,
                        author_kind=author_kind,
                        status="candidate",
                        revision_hash=revision_hash,
                        created_at=now,
                        **self._revision_columns(semantic),
                    )
                    transaction.add(revision)
                    await transaction.flush()
                    branch.current_revision_id = revision.id
                    branch.status = "candidate"
                    branch.row_version += 1
                    branch.updated_at = now
                intent_revisions.append(revision)

            active_keys = {str(value["branch_key"]) for value in normalized}
            for key, branch in existing_branches.items():
                if key not in active_keys and branch.status != "superseded":
                    branch.status = "superseded"
                    branch.row_version += 1
                    branch.updated_at = now

            source_prompt_hash = content_hash({"origin_prompt": prompt})
            snapshot_payload = {
                "intent_revision_ids": [value.id for value in intent_revisions],
                "execution_order": [str(value["branch_key"]) for value in normalized],
                "combination_policy": policy,
                "source_prompt_hash": source_prompt_hash,
            }
            snapshot_hash = content_hash(snapshot_payload)
            current_set_revision = (
                await transaction.get(
                    CollaborationIntentSetRevisionRecord,
                    root.current_revision_id,
                )
                if root.current_revision_id
                else None
            )
            if current_set_revision is None or current_set_revision.revision_hash != snapshot_hash:
                revision_number = (
                    int(
                        await transaction.scalar(
                            select(func.max(CollaborationIntentSetRevisionRecord.revision)).where(
                                CollaborationIntentSetRevisionRecord.intent_set_id == root.id
                            )
                        )
                        or 0
                    )
                    + 1
                )
                if current_set_revision is not None and current_set_revision.status == "candidate":
                    current_set_revision.status = "superseded"
                current_set_revision = CollaborationIntentSetRevisionRecord(
                    id=new_id(),
                    intent_set_id=root.id,
                    revision=revision_number,
                    previous_revision_id=root.current_revision_id,
                    intent_revision_ids_json=[value.id for value in intent_revisions],
                    execution_order_json=[str(value["branch_key"]) for value in normalized],
                    combination_policy=policy,
                    source_prompt_hash=source_prompt_hash,
                    revision_hash=snapshot_hash,
                    author_kind=author_kind,
                    status="candidate",
                    created_at=now,
                )
                transaction.add(current_set_revision)
                await transaction.flush()
                root.current_revision_id = current_set_revision.id
                root.accepted_revision_id = None
                root.status = "candidate"
                root.row_version += 1
                root.updated_at = now

            await self._ensure_clarifications(
                transaction,
                root=root,
                revisions=intent_revisions,
                now=now,
            )
            result = await self._view(transaction, root)
        with bind_context(
            session_id=result["session_id"],
            product_run_id=run_id,
            resource_id=result["id"],
        ):
            logger.info(
                "intent_set_candidate_recorded revision=%d intent_count=%d policy=%s set_hash=%s",
                result["current_revision"]["revision"],
                len(result["intents"]),
                policy,
                result["current_revision"]["revision_hash"][:12],
            )
        return result

    async def accept_current(
        self,
        *,
        intent_set_id: str,
        expected_revision_hash: str,
    ) -> dict[str, Any]:
        """Accept exactly the current immutable aggregate revision."""

        async with self.database.sessions.begin() as transaction:
            root = await transaction.get(CollaborationIntentSetRecord, intent_set_id)
            if root is None or root.scope_id != self.scope_id:
                raise HarnessNotFound("Intent Set不存在")
            current = await transaction.get(
                CollaborationIntentSetRevisionRecord,
                root.current_revision_id,
            )
            if current is None:
                raise HarnessConflict("Intent Set当前revision引用损坏")
            if current.revision_hash != expected_revision_hash:
                raise HarnessConflict("Intent Set已变化，请重新审核当前revision")
            if root.accepted_revision_id == current.id and root.status == "accepted":
                return await self._view(transaction, root)
            current.status = "accepted"
            root.accepted_revision_id = current.id
            root.status = "accepted"
            root.row_version += 1
            root.updated_at = self._clock()
            revisions = await self._intent_revisions_for_set_revision(transaction, current)
            for revision in revisions:
                revision.status = "accepted"
                branch = await transaction.get(CollaborationIntentRecord, revision.intent_id)
                if branch is not None:
                    branch.accepted_revision_id = revision.id
                    branch.status = "accepted"
                    branch.row_version += 1
                    branch.updated_at = root.updated_at
            result = await self._view(transaction, root)
        with bind_context(
            session_id=result["session_id"],
            product_run_id=result["run_id"],
            resource_id=root.id,
        ):
            logger.info(
                "intent_set_accepted revision=%d set_hash=%s",
                current.revision,
                current.revision_hash[:12],
            )
        return result

    async def revise_intent(
        self,
        *,
        intent_id: str,
        expected_set_revision_hash: str,
        changes: Mapping[str, Any],
        reason: str,
    ) -> dict[str, Any]:
        """Create a human-authored Intent revision and a new set snapshot."""

        revision_reason = normalized_text(reason, field="修改原因", max_length=1000)
        async with self.database.sessions.begin() as transaction:
            branch = await transaction.get(CollaborationIntentRecord, intent_id)
            if branch is None:
                raise HarnessNotFound("Intent不存在")
            root = await transaction.get(CollaborationIntentSetRecord, branch.intent_set_id)
            if root is None or root.scope_id != self.scope_id:
                raise HarnessNotFound("Intent Set不存在")
            current_set = await transaction.get(
                CollaborationIntentSetRevisionRecord,
                root.current_revision_id,
            )
            current = await transaction.get(
                CollaborationIntentRevisionRecord,
                branch.current_revision_id,
            )
            if current_set is None or current is None:
                raise HarnessConflict("Intent当前revision引用损坏")
            if current_set.revision_hash != expected_set_revision_hash:
                raise HarnessConflict("Intent Set已变化，请重新加载后修改")
            bound_spec = await transaction.scalar(
                select(RunSpecRecord).where(
                    RunSpecRecord.bound_run_id == root.run_id,
                    RunSpecRecord.status == "bound",
                )
            )
            if bound_spec is not None:
                raise HarnessConflict("本轮RunSpec已经绑定，不能追溯修改Intent；请基于新Intent重新运行")
            semantic = self._revision_semantic(current)
            allowed_changes = {
                "scenario",
                "query_kind",
                "goal",
                "expected_outcome",
                "confidence",
                "project_hint",
                "selected_project_id",
                "needs_plan",
                "needs_clarification",
                "clarification_question",
                "context_keywords",
                "dependency_branch_keys",
                "constraints",
            }
            unknown = set(changes) - allowed_changes
            if unknown:
                raise HarnessValidationError(f"Intent包含不可修改字段：{sorted(unknown)}")
            semantic.update(changes)
            semantic["reason_summary"] = revision_reason
            normalized = self._normalize_intent(semantic, ordinal=branch.ordinal)
            if normalized["selected_project_id"]:
                project = await transaction.get(
                    ProductProjectRecord,
                    normalized["selected_project_id"],
                )
                if project is None or project.scope_id != self.scope_id:
                    raise HarnessValidationError("Intent关联的正式Project不存在")
            revised_semantic = self._semantic_payload(normalized)
            revised_hash = content_hash(revised_semantic)
            if revised_hash == current.revision_hash:
                raise HarnessValidationError("Intent没有发生变化")
            now = self._clock()
            current.status = "superseded"
            revised = CollaborationIntentRevisionRecord(
                id=new_id(),
                intent_id=branch.id,
                revision=current.revision + 1,
                previous_revision_id=current.id,
                source_model_call_revision_id=current.source_model_call_revision_id,
                author_kind="human",
                status="candidate",
                revision_hash=revised_hash,
                created_at=now,
                **self._revision_columns(revised_semantic),
            )
            transaction.add(revised)
            await transaction.flush()
            branch.current_revision_id = revised.id
            branch.accepted_revision_id = None
            branch.status = "candidate"
            branch.row_version += 1
            branch.updated_at = now

            intent_revision_ids = [
                revised.id if value == current.id else value
                for value in list(current_set.intent_revision_ids_json or [])
            ]
            snapshot_payload = {
                "intent_revision_ids": intent_revision_ids,
                "execution_order": list(current_set.execution_order_json or []),
                "combination_policy": current_set.combination_policy,
                "source_prompt_hash": current_set.source_prompt_hash,
            }
            current_set.status = "superseded"
            set_revision = CollaborationIntentSetRevisionRecord(
                id=new_id(),
                intent_set_id=root.id,
                revision=current_set.revision + 1,
                previous_revision_id=current_set.id,
                intent_revision_ids_json=intent_revision_ids,
                execution_order_json=list(current_set.execution_order_json or []),
                combination_policy=current_set.combination_policy,
                source_prompt_hash=current_set.source_prompt_hash,
                revision_hash=content_hash(snapshot_payload),
                author_kind="human",
                status="candidate",
                created_at=now,
            )
            transaction.add(set_revision)
            await transaction.flush()
            root.current_revision_id = set_revision.id
            root.accepted_revision_id = None
            root.status = "candidate"
            root.row_version += 1
            root.updated_at = now
            await self._ensure_clarifications(
                transaction,
                root=root,
                revisions=await self._intent_revisions_for_set_revision(transaction, set_revision),
                now=now,
            )
            result = await self._view(transaction, root)
        with bind_context(
            session_id=result["session_id"],
            product_run_id=result["run_id"],
            resource_id=intent_id,
        ):
            logger.info(
                "intent_revised intent_revision=%d set_revision=%d set_hash=%s",
                revised.revision,
                set_revision.revision,
                set_revision.revision_hash[:12],
            )
        return result

    async def get_for_run(self, run_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            root = await transaction.scalar(
                select(CollaborationIntentSetRecord).where(
                    CollaborationIntentSetRecord.run_id == run_id,
                    CollaborationIntentSetRecord.scope_id == self.scope_id,
                )
            )
            return await self._view(transaction, root) if root is not None else None

    async def list_for_session(self, session_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(CollaborationIntentSetRecord)
                        .where(
                            CollaborationIntentSetRecord.session_id == session_id,
                            CollaborationIntentSetRecord.scope_id == self.scope_id,
                        )
                        .order_by(CollaborationIntentSetRecord.created_at.desc())
                        .limit(max(1, min(limit, 100)))
                    )
                ).all()
            )
            return [await self._view(transaction, value) for value in values]

    async def latest_open_clarification(self, session_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            value = await transaction.scalar(
                select(ClarificationRequestRecord)
                .where(
                    ClarificationRequestRecord.session_id == session_id,
                    ClarificationRequestRecord.scope_id == self.scope_id,
                    ClarificationRequestRecord.status == "open",
                )
                .order_by(ClarificationRequestRecord.created_at.desc())
                .limit(1)
            )
            return self._clarification_view(value) if value is not None else None

    async def answer_latest_open(
        self,
        *,
        session_id: str,
        answering_run_id: str,
        answer_text: str,
    ) -> dict[str, Any] | None:
        """Bind normal Chat input to the latest open clarification exactly once."""

        answer = normalized_text(answer_text, field="澄清回答", max_length=20_000)
        answer_hash = content_hash({"answer": answer})
        async with self.database.sessions.begin() as transaction:
            request = await transaction.scalar(
                select(ClarificationRequestRecord)
                .where(
                    ClarificationRequestRecord.session_id == session_id,
                    ClarificationRequestRecord.scope_id == self.scope_id,
                    ClarificationRequestRecord.status == "open",
                )
                .order_by(ClarificationRequestRecord.created_at.desc())
                .limit(1)
            )
            if request is None:
                return None
            existing = await transaction.scalar(
                select(ClarificationAnswerRecord).where(
                    ClarificationAnswerRecord.clarification_request_id == request.id,
                    ClarificationAnswerRecord.answer_hash == answer_hash,
                )
            )
            if existing is None:
                existing = ClarificationAnswerRecord(
                    id=new_id(),
                    clarification_request_id=request.id,
                    answering_run_id=answering_run_id,
                    revision=1,
                    answer_text=answer,
                    answer_hash=answer_hash,
                    created_by=self.principal_id,
                    created_at=self._clock(),
                )
                transaction.add(existing)
                await transaction.flush()
            request.current_answer_id = existing.id
            request.status = "answered"
            request.row_version += 1
            request.answered_at = self._clock()
            result = {
                **self._clarification_view(request),
                "answer": {
                    "id": existing.id,
                    "answer_text": existing.answer_text,
                    "answer_hash": existing.answer_hash,
                    "answering_run_id": existing.answering_run_id,
                },
            }
        with bind_context(
            session_id=session_id,
            product_run_id=answering_run_id,
            resource_id=request.id,
        ):
            logger.info("clarification_answered answer_hash=%s", answer_hash[:12])
        return result

    async def _ensure_clarifications(
        self,
        transaction,
        *,
        root: CollaborationIntentSetRecord,
        revisions: Sequence[CollaborationIntentRevisionRecord],
        now: datetime,
    ) -> None:
        active_revision_ids = {value.id for value in revisions if value.needs_clarification}
        open_values = list(
            (
                await transaction.scalars(
                    select(ClarificationRequestRecord).where(
                        ClarificationRequestRecord.session_id == root.session_id,
                        ClarificationRequestRecord.status == "open",
                    )
                )
            ).all()
        )
        for value in open_values:
            if value.intent_revision_id not in active_revision_ids:
                value.status = "superseded"
                value.row_version += 1
        for revision in revisions:
            if not revision.needs_clarification:
                continue
            existing = await transaction.scalar(
                select(ClarificationRequestRecord).where(
                    ClarificationRequestRecord.intent_revision_id == revision.id
                )
            )
            if existing is None:
                question = revision.clarification_question or "你希望我接下来具体推进哪件事？"
                transaction.add(
                    ClarificationRequestRecord(
                        id=new_id(),
                        scope_id=self.scope_id,
                        session_id=root.session_id,
                        originating_run_id=root.run_id,
                        intent_revision_id=revision.id,
                        question=question,
                        answer_schema_json={"type": "free_text", "required": True},
                        options_json=[],
                        status="open",
                        row_version=1,
                        created_at=now,
                    )
                )

    def _normalize_intents(
        self,
        values: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        if not values:
            raise HarnessValidationError("Intent Set至少包含一个Intent")
        if len(values) > MAX_INTENTS_PER_TURN:
            raise HarnessValidationError(f"单轮最多支持{MAX_INTENTS_PER_TURN}个Intent")
        normalized = [self._normalize_intent(value, ordinal=index) for index, value in enumerate(values)]
        keys = [str(value["branch_key"]) for value in normalized]
        if len(keys) != len(set(keys)):
            raise HarnessValidationError("Intent branch_key不能重复")
        positions = {key: index for index, key in enumerate(keys)}
        for index, value in enumerate(normalized):
            for dependency in value["dependency_branch_keys"]:
                if dependency not in positions:
                    raise HarnessValidationError(f"Intent依赖不存在：{dependency}")
                if positions[dependency] >= index:
                    raise HarnessValidationError("Intent依赖必须指向执行顺序中更早的分支")
        return normalized

    def _normalize_intent(self, raw: Mapping[str, Any], *, ordinal: int) -> dict[str, Any]:
        scenario = str(raw.get("scenario") or "clarify")
        if scenario not in SUPPORTED_SCENARIOS:
            raise HarnessValidationError(f"Intent场景无效：{scenario}")
        confidence = raw.get("confidence", 0)
        if not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
            raise HarnessValidationError("Intent confidence必须在0到1之间")
        branch_key = str(raw.get("branch_key") or f"intent_{ordinal + 1}").strip()
        if not branch_key or len(branch_key) > 80:
            raise HarnessValidationError("Intent branch_key无效")
        goal = normalized_text(str(raw.get("goal") or ""), field="Intent目标", max_length=4000)
        expected_outcome = str(raw.get("expected_outcome") or goal).strip()
        clarification_question = _optional_text(raw.get("clarification_question"), max_length=4000)
        needs_clarification = bool(raw.get("needs_clarification") or scenario == "clarify")
        if needs_clarification and not clarification_question:
            clarification_question = "你希望我接下来具体推进哪件事？"
        return {
            "branch_key": branch_key,
            "scenario": scenario,
            "query_kind": _optional_text(raw.get("query_kind"), max_length=60),
            "goal": goal,
            "expected_outcome": normalized_text(
                expected_outcome,
                field="Intent预期结果",
                max_length=4000,
            ),
            "confidence": float(confidence),
            "project_hint": _optional_text(raw.get("project_hint"), max_length=240),
            "selected_project_id": _optional_text(raw.get("selected_project_id"), max_length=36),
            "needs_plan": bool(raw.get("needs_plan")),
            "needs_clarification": needs_clarification,
            "clarification_question": clarification_question,
            "context_keywords": _string_list(raw.get("context_keywords"), field="context_keywords"),
            "dependency_branch_keys": _string_list(
                raw.get("dependency_branch_keys"),
                field="dependency_branch_keys",
            ),
            "constraints": _string_list(raw.get("constraints"), field="constraints"),
            "reason_summary": normalized_text(
                str(raw.get("reason_summary") or "未提供判断摘要"),
                field="Intent判断摘要",
                max_length=4000,
            ),
        }

    @staticmethod
    def _semantic_payload(value: Mapping[str, Any]) -> dict[str, Any]:
        return {
            key: value.get(key)
            for key in (
                "scenario",
                "query_kind",
                "goal",
                "expected_outcome",
                "confidence",
                "project_hint",
                "selected_project_id",
                "needs_plan",
                "needs_clarification",
                "clarification_question",
                "context_keywords",
                "dependency_branch_keys",
                "constraints",
                "reason_summary",
            )
        }

    @staticmethod
    def _revision_columns(value: Mapping[str, Any]) -> dict[str, Any]:
        """Map public array field names to their storage column names."""

        result = dict(value)
        result["context_keywords_json"] = result.pop("context_keywords")
        result["dependency_branch_keys_json"] = result.pop("dependency_branch_keys")
        result["constraints_json"] = result.pop("constraints")
        return result

    @staticmethod
    def _revision_semantic(value: CollaborationIntentRevisionRecord) -> dict[str, Any]:
        return {
            "scenario": value.scenario,
            "query_kind": value.query_kind,
            "goal": value.goal,
            "expected_outcome": value.expected_outcome,
            "confidence": value.confidence,
            "project_hint": value.project_hint,
            "selected_project_id": value.selected_project_id,
            "needs_plan": value.needs_plan,
            "needs_clarification": value.needs_clarification,
            "clarification_question": value.clarification_question,
            "context_keywords": list(value.context_keywords_json or []),
            "dependency_branch_keys": list(value.dependency_branch_keys_json or []),
            "constraints": list(value.constraints_json or []),
            "reason_summary": value.reason_summary,
        }

    async def _intent_revisions_for_set_revision(
        self,
        transaction,
        value: CollaborationIntentSetRevisionRecord,
    ) -> list[CollaborationIntentRevisionRecord]:
        revisions: list[CollaborationIntentRevisionRecord] = []
        for revision_id in list(value.intent_revision_ids_json or []):
            revision = await transaction.get(CollaborationIntentRevisionRecord, revision_id)
            if revision is None:
                raise HarnessConflict("Intent Set revision引用了不存在的Intent revision")
            revisions.append(revision)
        return revisions

    async def _view(self, transaction, root: CollaborationIntentSetRecord) -> dict[str, Any]:
        current = await transaction.get(
            CollaborationIntentSetRevisionRecord,
            root.current_revision_id,
        )
        if current is None:
            raise HarnessConflict("Intent Set当前revision引用损坏")
        revisions = await self._intent_revisions_for_set_revision(transaction, current)
        branches = {
            value.id: value
            for value in (
                await transaction.scalars(
                    select(CollaborationIntentRecord).where(
                        CollaborationIntentRecord.intent_set_id == root.id
                    )
                )
            ).all()
        }
        clarifications = {
            value.intent_revision_id: value
            for value in (
                await transaction.scalars(
                    select(ClarificationRequestRecord).where(
                        ClarificationRequestRecord.intent_revision_id.in_(
                            [revision.id for revision in revisions]
                        )
                    )
                )
            ).all()
        }
        intents: list[dict[str, Any]] = []
        for revision in revisions:
            branch = branches[revision.intent_id]
            clarification = clarifications.get(revision.id)
            intents.append(
                {
                    "id": branch.id,
                    "branch_key": branch.branch_key,
                    "ordinal": branch.ordinal,
                    "status": branch.status,
                    "row_version": branch.row_version,
                    "current_revision": {
                        "id": revision.id,
                        "revision": revision.revision,
                        **self._revision_semantic(revision),
                        "status": revision.status,
                        "revision_hash": revision.revision_hash,
                        "author_kind": revision.author_kind,
                        "source_model_call_revision_id": revision.source_model_call_revision_id,
                        "created_at": _iso_timestamp(revision.created_at),
                    },
                    "clarification": (
                        self._clarification_view(clarification) if clarification is not None else None
                    ),
                }
            )
        return {
            "id": root.id,
            "scope_id": root.scope_id,
            "session_id": root.session_id,
            "interaction_id": root.interaction_id,
            "run_id": root.run_id,
            "status": root.status,
            "row_version": root.row_version,
            "current_revision": {
                "id": current.id,
                "revision": current.revision,
                "execution_order": list(current.execution_order_json or []),
                "combination_policy": current.combination_policy,
                "source_prompt_hash": current.source_prompt_hash,
                "revision_hash": current.revision_hash,
                "author_kind": current.author_kind,
                "status": current.status,
                "created_at": _iso_timestamp(current.created_at),
            },
            "accepted_revision_id": root.accepted_revision_id,
            "intents": intents,
            "created_at": _iso_timestamp(root.created_at),
            "updated_at": _iso_timestamp(root.updated_at),
        }

    @staticmethod
    def _clarification_view(value: ClarificationRequestRecord) -> dict[str, Any]:
        return {
            "id": value.id,
            "session_id": value.session_id,
            "originating_run_id": value.originating_run_id,
            "intent_revision_id": value.intent_revision_id,
            "question": value.question,
            "answer_schema": dict(value.answer_schema_json or {}),
            "options": list(value.options_json or []),
            "status": value.status,
            "current_answer_id": value.current_answer_id,
            "row_version": value.row_version,
            "created_at": _iso_timestamp(value.created_at),
            "answered_at": _iso_timestamp(value.answered_at),
        }


def _optional_text(value: Any, *, max_length: int) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    if len(normalized) > max_length:
        raise HarnessValidationError(f"字段不能超过{max_length}个字符")
    return normalized


def _string_list(value: Any, *, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise HarnessValidationError(f"{field}必须是字符串数组")
    return [item.strip() for item in value if item.strip()]


def _iso_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()

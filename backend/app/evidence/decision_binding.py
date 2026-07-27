"""Shared result_commit Decision binding validator (第四轮复审P0-3/P2-9).

One validator serves the Result Commit Gate, the recording layer's
``create_adoption`` and the ``require_bound_result_commit_decision`` guard, so
the exact-binding rules exist exactly once.  It receives the caller-owned
``AsyncSession`` and never opens or commits a transaction (AGENTS.md §7.1).

Checks, in order:

1. DecisionPointDefinition/PolicyEvaluation/DecisionSubject chain exists and
   belongs to the ``result_commit`` / ``result_candidate`` point.
2. The subject binds the *current* Claim id and row_version.
3. ``decision.bound_subject_hash == subject.subject_hash`` **and** the
   subject's stored hash equals a fresh recomputation over
   ``decision_view_json`` — a post-creation rewrite of the view fails closed
   instead of letting an old Decision authorize new content.
4. The view binds the exact Claim hash and row_version.
5. Returns the frozen ``action_outcomes`` entry selected by the Decision's own
   ``decision_code``; callers apply their outcome-specific rules on top.
"""

from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy.ext.asyncio import AsyncSession

from ..governance.models import (
    DecisionPointDefinitionRecord,
    DecisionSubjectRecord,
    PolicyEvaluationRecord,
)
from ..governance.service import decision_subject_content_hash
from .contracts import ResultCommitDecisionInvalid
from .models import CompletionClaimRecord


async def require_result_commit_decision(
    transaction: AsyncSession,
    *,
    decision: Any,
    claim: CompletionClaimRecord,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    """Validate the Decision chain and return (view, selected outcome)."""

    subject = await transaction.get(DecisionSubjectRecord, getattr(decision, "subject_id", None))
    evaluation = await transaction.get(
        PolicyEvaluationRecord,
        getattr(decision, "policy_evaluation_id", None),
    )
    point = (
        None
        if evaluation is None
        else await transaction.get(
            DecisionPointDefinitionRecord,
            evaluation.decision_point_definition_id,
        )
    )
    view = getattr(subject, "decision_view_json", None)
    if (
        subject is None
        or evaluation is None
        or point is None
        or getattr(decision, "subject_id", None) != subject.id
        or evaluation.subject_id != subject.id
        or point.key != "result_commit"
        or point.subject_kind != "result_candidate"
        or subject.subject_kind != "result_candidate"
        or subject.resource_id != claim.id
        or subject.resource_revision != str(claim.row_version)
        or getattr(decision, "bound_subject_hash", None) != subject.subject_hash
        or not isinstance(view, Mapping)
        or view.get("claim_id") != claim.id
        or view.get("claim_hash") != claim.claim_hash
        or view.get("claim_row_version") != claim.row_version
    ):
        raise ResultCommitDecisionInvalid("Decision未精确绑定当前Claim版本与ResultCommit结局")
    # P0-3：复算不可变Subject的内容Hash；创建后改写decision_view_json必然
    # 与存储Hash漂移，旧Decision不能授权新内容。
    if decision_subject_content_hash(view) != subject.subject_hash:
        raise ResultCommitDecisionInvalid("DecisionSubject内容与Hash不一致")
    raw_outcomes = view.get("action_outcomes")
    outcome = (
        raw_outcomes.get(getattr(decision, "decision_code", None))
        if isinstance(raw_outcomes, Mapping)
        else None
    )
    if not isinstance(outcome, Mapping):
        raise ResultCommitDecisionInvalid("Decision的decision_code没有对应的冻结outcome")
    return view, outcome

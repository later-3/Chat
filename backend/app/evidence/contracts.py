"""Pure rules, state machines and payload validators for Evidence/Artifact lifecycle."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


class EvidenceError(ValueError):
    code = "EVIDENCE_INVALID"
    http_status = 409


class EvidenceNotFound(EvidenceError):
    code = "RESOURCE_NOT_FOUND"
    http_status = 404


class EvidenceConflict(EvidenceError):
    code = "RESOURCE_VERSION_CONFLICT"
    http_status = 409


class EvidenceValidationError(EvidenceError):
    code = "REQUEST_VALIDATION_FAILED"
    http_status = 422


# 细分错误码对应设计文档 §13.5；REST 映射层按 code 输出 Problem Detail。
class CompletionClaimAlreadyResolved(EvidenceConflict):
    code = "COMPLETION_CLAIM_ALREADY_RESOLVED"


class ArtifactHashMismatch(EvidenceConflict):
    code = "ARTIFACT_HASH_MISMATCH"


class ArtifactBlobMissing(EvidenceConflict):
    code = "ARTIFACT_BLOB_MISSING"


class ArtifactStorageConflict(EvidenceConflict):
    code = "ARTIFACT_STORAGE_CONFLICT"


class ArtifactStoragePathInvalid(EvidenceValidationError):
    code = "ARTIFACT_STORAGE_PATH_INVALID"


class ArtifactRevisionSuperseded(EvidenceConflict):
    code = "ARTIFACT_REVISION_SUPERSEDED"


class ArtifactApplicabilityStale(EvidenceConflict):
    code = "ARTIFACT_APPLICABILITY_STALE"


class CompletionRequirementUnsatisfied(EvidenceValidationError):
    code = "COMPLETION_REQUIREMENT_UNSATISFIED"


class EvidenceInvalid(EvidenceConflict):
    """An adopted Evidence chain no longer satisfies the exact Claim."""

    code = "EVIDENCE_INVALID"


class ResultCommitDecisionInvalid(EvidenceConflict):
    """The DecisionRecord is not bound to this Claim revision and outcome."""

    code = "RESULT_COMMIT_DECISION_INVALID"


class WaiverBlockedByFailedRequirement(EvidenceValidationError):
    code = "WAIVER_BLOCKED_BY_FAILED_REQUIREMENT"


class AssessmentNotSupporting(EvidenceValidationError):
    code = "ASSESSMENT_NOT_SUPPORTING"


class SubjectTransitionNotAllowed(EvidenceValidationError):
    code = "SUBJECT_TRANSITION_NOT_ALLOWED"


class SourceInvalidated(EvidenceError):
    code = "SOURCE_INVALIDATED"
    http_status = 410


class RuntimeLeaseFenceMismatch(EvidenceConflict):
    code = "RUNTIME_LEASE_FENCE_MISMATCH"


class ValidationOutcomeUnknown(EvidenceConflict):
    code = "VALIDATION_OUTCOME_UNKNOWN"


class ValidationContractMismatch(EvidenceConflict):
    code = "VALIDATION_CONTRACT_MISMATCH"


class ValidationCapabilityUnavailable(EvidenceValidationError):
    code = "VALIDATION_CAPABILITY_UNAVAILABLE"


class ResultCommitGateUnavailable(EvidenceError):
    """accepted/waived ResultCommit requires the SD4-C commit gate re-check.

    Until that coordinator is delivered, the record layer must fail closed
    instead of fabricating ``pre_commit_validity_check_passed=True`` (E02).
    """

    code = "RESULT_COMMIT_GATE_UNAVAILABLE"
    http_status = 409


class ValidationTimeout(EvidenceError):
    code = "VALIDATION_TIMEOUT"
    http_status = 504


@dataclass(frozen=True)
class ClaimGateRecheck:
    """Proof that the SD4-C Result Commit Gate re-checked a Claim.

    Only ``ResultCommitCoordinator`` can produce this value, and only inside
    the commit transaction.  The recording layer refuses accepted/waived
    commits without it, so ``pre_commit_validity_check_passed`` can never be
    set by mechanically flipping a boolean (E02, 反例033).
    """

    claim_id: str
    claim_hash: str
    claim_row_version: int
    commit_status: str
    mandatory_requirement_ids: tuple[str, ...]
    adoption_ids: tuple[str, ...]
    waiver_ids: tuple[str, ...]
    artifact_revision_id: str | None
    artifact_record_version: int | None


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


# Artifact lifecycle.  Only listed transitions are legal; every other pair is rejected.
ARTIFACT_TRANSITIONS: dict[str, set[str]] = {
    "candidate": {"accepted", "rejected", "not_adopted", "discarded"},
    "accepted": {"retained", "discarded"},
    "rejected": {"retained", "discarded"},
    "not_adopted": {"retained", "discarded"},
    "retained": {"discarded"},
    "discarded": set(),
}

# Special: appending a Revision resets the Record to candidate while preserving the
# old Revision outcome.  This flag is checked separately from the state machine.
ARTIFACT_REVISION_APPEND_ALLOWS_RECORD_CANDIDATE = True

# Claim lifecycle.  A Claim is created as a candidate and resolved exactly once.
CLAIM_TRANSITIONS: dict[str, set[str]] = {
    "candidate": {"committed", "rejected", "superseded"},
    "committed": set(),
    "rejected": set(),
    "superseded": set(),
}

RESULT_COMMIT_STATUSES = {"accepted", "rejected", "waived"}
ARTIFACT_DISPOSITIONS = {"accepted", "rejected", "not_adopted", "none"}

# Validity is a mutable property of an Observation, driven by source invalidation events.
OBSERVATION_VALIDITIES = {"valid", "stale", "unavailable", "revoked", "unverifiable"}

# Assessment verdicts are immutable rows; the "current" assessment for a Requirement
# is the one with the highest assessment_sequence.
ASSESSMENT_VERDICTS = {"supports", "refutes", "inconclusive"}
ASSESSOR_KINDS = {"validator", "workflow", "human"}

# ValidationRun deterministic statuses.
VALIDATION_RUN_STATUSES = {
    "pending",
    "running",
    "passed",
    "failed",
    "timeout",
    "error",
    "cancelled",
    "outcome_unknown",
}

# §6.5: only listed transitions are legal; outcome_unknown is terminal and never
# auto-retried into passed/failed.
VALIDATION_RUN_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"running", "error", "cancelled"},
    "running": {"passed", "failed", "timeout", "error", "outcome_unknown", "cancelled"},
    "passed": set(),
    "failed": set(),
    "timeout": set(),
    "error": set(),
    "cancelled": set(),
    "outcome_unknown": set(),
}

VALIDATION_RUN_TERMINAL_STATUSES = {
    "passed",
    "failed",
    "timeout",
    "error",
    "cancelled",
    "outcome_unknown",
}

# Artifact kinds per §4.3.
ARTIFACT_KINDS = {
    "diff_patch",
    "validation_report",
    "generated_file",
    "design_document",
    "result_patch",
    "exported_content",
}

# Artifact blob lifecycle per §4.2.
ARTIFACT_BLOB_INTEGRITY_STATUSES = {"available", "missing", "corrupt"}
ARTIFACT_BLOB_GC_STATUSES = {"active", "orphan_candidate", "deleting", "delete_failed"}

# Claim subject kinds per §4.6; Observation subject kinds per §4.5.
CLAIM_SUBJECT_KINDS = {"work_item", "action_item"}
OBSERVATION_SUBJECT_KINDS = {"work_item", "action_item", "artifact_revision"}

# Source invalidation source kinds per §4.16.
INVALIDATION_SOURCE_KINDS = {
    "artifact_blob",
    "repository_snapshot",
    "artifact_revision",
    "evidence_observation",
}

# Source invalidation event kinds and resolutions.
INVALIDATION_KINDS = {"stale", "unavailable", "revoked", "recovered"}
INVALIDATION_RESOLUTIONS = {"pending", "applied", "dismissed"}

# Capability catalog.
VALIDATION_CAPABILITY_EXECUTABLE_POLICIES = {
    "project_venv_python",
    "pinned_binary",
    "builtin",
}
VALIDATION_CAPABILITY_PATH_POLICIES = {"workspace_only", "workspace_plus_declared_read"}
VALIDATION_CAPABILITY_SIDE_EFFECT_CLASSES = {"readonly", "temp_write"}
VALIDATION_CAPABILITY_NETWORK_POLICIES = {"deny", "allowlist"}

# Requirement kinds a Claim can demand.
REQUIREMENT_KINDS = {
    "validation_result",
    "file_hash_match",
    "tool_receipt",
    "model_output_adoption",
    "human_confirmation",
    "external_observation",
}

# Provenance relation and kind enums.
PROVENANCE_RELATIONS = {"derived_from", "generated_by", "used", "attributed_to", "invalidated_by"}
PROVENANCE_SOURCE_KINDS = {
    "artifact_revision",
    "evidence_observation",
    "evidence_assessment",
    "claim_evidence_adoption",
    "requirement_waiver",
    "validation_run",
    "completion_claim",
    "result_commit",
    "tool_operation",
    "product_run",
    "run_attempt",
}
PROVENANCE_TARGET_KINDS = {
    "artifact_revision",
    "evidence_observation",
    "evidence_assessment",
    "claim_evidence_adoption",
    "requirement_waiver",
    "validation_run",
    "execution_workspace",
    "repository_snapshot",
    "decision_record",
    "work_item",
    "action_item",
    "source_invalidation",
    "completion_claim",
    "result_commit",
    "tool_operation",
    "product_run",
    "run_attempt",
}

# Applicability policy for a Claim: what to do when the repository snapshot advances.
APPLICABILITY_POLICIES = {"record_only", "must_match_current_target"}

# Subject transitions a CompletionClaim can request.
CLAIM_TARGET_TRANSITIONS = {"action_result_accepted", "work_completed"}

# §4.6 subject 迁移协议：每个 (subject_kind, target_transition) 只允许一个
# (from_state, target_state) 组合，且必须同时被 Harness 既有状态机允许。
# from_state 以权威 Subject 当前状态为准，调用方提供的值只是乐观断言（E04）。
CLAIM_SUBJECT_TRANSITION_RULES: dict[tuple[str, str], tuple[str, str]] = {
    ("action_item", "action_result_accepted"): ("in_progress", "completed"),
    ("work_item", "work_completed"): ("in_progress", "completed"),
}

# §4.15.1 allowed (relation -> (source_kinds, target_kinds)) matrix.  Anything
# outside the matrix is rejected, including reverse writes.
PROVENANCE_RELATION_MATRIX: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    "derived_from": (
        frozenset({"artifact_revision", "evidence_observation"}),
        frozenset({"artifact_revision", "evidence_observation", "repository_snapshot"}),
    ),
    "generated_by": (
        frozenset({"artifact_revision"}),
        frozenset({"validation_run", "tool_operation", "product_run", "run_attempt"}),
    ),
    "used": (
        frozenset({"validation_run", "tool_operation", "product_run", "run_attempt"}),
        frozenset({"artifact_revision", "decision_record"}),
    ),
    "attributed_to": (
        frozenset(
            {
                "artifact_revision",
                "evidence_observation",
                "evidence_assessment",
                "claim_evidence_adoption",
                "requirement_waiver",
                "result_commit",
            }
        ),
        frozenset({"work_item", "action_item", "completion_claim", "decision_record"}),
    ),
    "invalidated_by": (
        frozenset({"evidence_observation", "artifact_revision"}),
        frozenset({"source_invalidation"}),
    ),
}


def provenance_edge_allowed(source_kind: str, relation: str, target_kind: str) -> bool:
    matrix = PROVENANCE_RELATION_MATRIX.get(relation)
    if matrix is None:
        return False
    sources, targets = matrix
    return source_kind in sources and target_kind in targets


# Payload schema versions and validators.  Each Observation kind must match a schema
# version that the code understands; unknown schema versions are rejected.
VALIDATION_RESULT_SCHEMA_VERSION = "validation-result-v1"
FILE_HASH_MATCH_SCHEMA_VERSION = "file-hash-match-v1"
TOOL_RECEIPT_SCHEMA_VERSION = "tool-receipt-v1"
MODEL_OUTPUT_ADOPTION_SCHEMA_VERSION = "model-output-adoption-v1"
HUMAN_CONFIRMATION_SCHEMA_VERSION = "human-confirmation-v1"
EXTERNAL_OBSERVATION_SCHEMA_VERSION = "external-observation-v1"


def _require(value: dict[str, Any], key: str, type_: type | tuple[type, ...]) -> Any:
    if key not in value:
        raise EvidenceValidationError(f"payload缺少字段: {key}")
    if not isinstance(value[key], type_):
        raise EvidenceValidationError(f"payload字段类型错误: {key}")
    return value[key]


def validate_validation_result_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceValidationError("validation_result payload必须是对象")
    capability_key = _require(payload, "capability_key", str)
    expanded_argv = _require(payload, "expanded_argv", list)
    working_dir = _require(payload, "working_dir", str)
    exit_code = _require(payload, "exit_code", int)
    signal = payload.get("signal")
    if signal is not None and not isinstance(signal, int):
        raise EvidenceValidationError("signal必须是整数或null")
    summary = _require(payload, "summary", str)
    duration_ms = _require(payload, "duration_ms", int)
    if duration_ms < 0:
        raise EvidenceValidationError("duration_ms不能为负数")
    return {
        "capability_key": capability_key,
        "expanded_argv": [str(value) for value in expanded_argv],
        "working_dir": working_dir,
        "exit_code": exit_code,
        "signal": signal,
        "summary": summary,
        "duration_ms": duration_ms,
    }


def validate_file_hash_match_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceValidationError("file_hash_match payload必须是对象")
    path = _require(payload, "path", str)
    preimage_hash = _require(payload, "preimage_hash", str)
    postimage_hash = _require(payload, "postimage_hash", str)
    observed_hash = _require(payload, "observed_hash", str)
    match = _require(payload, "match", bool)
    return {
        "path": path,
        "preimage_hash": preimage_hash,
        "postimage_hash": postimage_hash,
        "observed_hash": observed_hash,
        "match": match,
    }


def validate_tool_receipt_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceValidationError("tool_receipt payload必须是对象")
    tool_operation_id = _require(payload, "tool_operation_id", str)
    tool_name = _require(payload, "tool_name", str)
    side_effect_class = _require(payload, "side_effect_class", str)
    preimage_hash = _require(payload, "preimage_hash", str)
    postimage_hash = _require(payload, "postimage_hash", str)
    observed_hash = _require(payload, "observed_hash", str)
    return {
        "tool_operation_id": tool_operation_id,
        "tool_name": tool_name,
        "side_effect_class": side_effect_class,
        "preimage_hash": preimage_hash,
        "postimage_hash": postimage_hash,
        "observed_hash": observed_hash,
    }


def validate_model_output_adoption_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceValidationError("model_output_adoption payload必须是对象")
    model_call_attempt_id = _require(payload, "model_call_attempt_id", str)
    output_disposition = _require(payload, "output_disposition", str)
    adopted_text_hash = _require(payload, "adopted_text_hash", str)
    adoption_scope = _require(payload, "adoption_scope", str)
    return {
        "model_call_attempt_id": model_call_attempt_id,
        "output_disposition": output_disposition,
        "adopted_text_hash": adopted_text_hash,
        "adoption_scope": adoption_scope,
    }


def validate_human_confirmation_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceValidationError("human_confirmation payload必须是对象")
    confirmed_by_principal_id = _require(payload, "confirmed_by_principal_id", str)
    confirmation_text_hash = _require(payload, "confirmation_text_hash", str)
    confirmation_kind = _require(payload, "confirmation_kind", str)
    return {
        "confirmed_by_principal_id": confirmed_by_principal_id,
        "confirmation_text_hash": confirmation_text_hash,
        "confirmation_kind": confirmation_kind,
    }


def validate_external_observation_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EvidenceValidationError("external_observation payload必须是对象")
    observation_kind = _require(payload, "observation_kind", str)
    external_source = _require(payload, "external_source", str)
    result_summary = _require(payload, "result_summary", str)
    external_reference = _require(payload, "external_reference", str)
    return {
        "observation_kind": observation_kind,
        "external_source": external_source,
        "result_summary": result_summary,
        "external_reference": external_reference,
    }


PAYLOAD_VALIDATORS: dict[str, dict[str, Callable[[Any], dict[str, Any]]]] = {
    "validation_result": {
        VALIDATION_RESULT_SCHEMA_VERSION: validate_validation_result_payload,
    },
    "file_hash_match": {
        FILE_HASH_MATCH_SCHEMA_VERSION: validate_file_hash_match_payload,
    },
    "tool_receipt": {
        TOOL_RECEIPT_SCHEMA_VERSION: validate_tool_receipt_payload,
    },
    "model_output_adoption": {
        MODEL_OUTPUT_ADOPTION_SCHEMA_VERSION: validate_model_output_adoption_payload,
    },
    "human_confirmation": {
        HUMAN_CONFIRMATION_SCHEMA_VERSION: validate_human_confirmation_payload,
    },
    "external_observation": {
        EXTERNAL_OBSERVATION_SCHEMA_VERSION: validate_external_observation_payload,
    },
}


def validate_observation_payload(*, kind: str, schema_version: str, payload: Any) -> dict[str, Any]:
    versions = PAYLOAD_VALIDATORS.get(kind)
    if versions is None:
        raise EvidenceValidationError(f"未知Observation kind: {kind}")
    validator = versions.get(schema_version)
    if validator is None:
        raise EvidenceValidationError(f"未知schema版本: {kind}@{schema_version}")
    return validator(payload)


def claim_hash(
    *,
    subject_kind: str,
    subject_id: str,
    expected_subject_version: int,
    from_state: str,
    target_transition: str,
    target_state: str,
    validation_contract_id: str | None,
    artifact_revision_id: str | None,
    expected_artifact_record_version: int | None,
    repository_snapshot_id: str | None,
    applicability_policy: str,
    requirements: list[dict[str, Any]],
) -> str:
    """Stable hash of a Claim's immutable content.

    Every field that can change the approval consequence must be bound here:
    the subject and its expected version, the exact state transition, the
    validation contract, the artifact revision and its expected record
    version, the repository snapshot, the applicability policy and the
    requirement set.  Excluding any of them would let a caller mutate the
    commit precondition after approval without changing the hash (E01).
    """
    canonical_requirements = [
        {
            "index": value["requirement_index"],
            "kind": value["requirement_kind"],
            "mandatory": bool(value["mandatory"]),
            "description": str(value["description"]),
            "contract_rule_ordinal": value.get("contract_rule_ordinal"),
            "params_json": canonical_json(value.get("params_json") or {}),
            "schema_version": str(value["schema_version"]),
        }
        for value in sorted(requirements, key=lambda item: item["requirement_index"])
    ]
    return content_hash(
        {
            "subject_kind": subject_kind,
            "subject_id": subject_id,
            "expected_subject_version": expected_subject_version,
            "from_state": from_state,
            "target_transition": target_transition,
            "target_state": target_state,
            "validation_contract_id": validation_contract_id,
            "artifact_revision_id": artifact_revision_id,
            "expected_artifact_record_version": expected_artifact_record_version,
            "repository_snapshot_id": repository_snapshot_id,
            "applicability_policy": applicability_policy,
            "requirements": canonical_requirements,
        }
    )


def validation_run_command_hash(
    *,
    workspace_id: str,
    repository_snapshot_id: str,
    validation_contract_id: str,
    rule_ordinal: int,
    repair_cycle: int,
    runtime_job_id: str,
    run_attempt_id: str,
) -> str:
    """Idempotent command hash for creating a ValidationRun."""
    return content_hash(
        {
            "workspace_id": workspace_id,
            "repository_snapshot_id": repository_snapshot_id,
            "validation_contract_id": validation_contract_id,
            "rule_ordinal": rule_ordinal,
            "repair_cycle": repair_cycle,
            "runtime_job_id": runtime_job_id,
            "run_attempt_id": run_attempt_id,
        }
    )

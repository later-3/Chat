"""Pure validation, hashing and public projections for collaboration protocols."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime
from typing import Any, Mapping, Sequence

from .models import (
    CollaborationProtocolBindingRecord,
    CollaborationProtocolDefinitionRecord,
    CollaborationProtocolRuleRecord,
)

PROTOCOL_STATUSES = {"active", "deprecated", "blocked"}
BINDING_STATUSES = {"active", "disabled"}
BINDING_SCOPE_KINDS = {"system", "user", "project", "work_item"}
SCENARIO_KINDS = {
    "simple_question",
    "software_delivery",
    "project",
    "task",
    "learning",
    "research",
    "recurring",
}
RULE_ENFORCEMENTS = {"deterministic", "reviewer", "human"}
RULE_SEVERITIES = {"advisory", "required", "prohibited"}
RULE_FAILURE_ACTIONS = {"warn", "repair", "rehitl", "block"}


class ProtocolError(ValueError):
    code = "PROTOCOL_INVALID"


class ProtocolNotFound(ProtocolError):
    code = "PROTOCOL_NOT_FOUND"


class ProtocolConflict(ProtocolError):
    code = "PROTOCOL_CONFLICT"


class ProtocolValidationError(ProtocolError):
    code = "PROTOCOL_VALIDATION_FAILED"


def new_id() -> str:
    return str(uuid.uuid4())


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def normalized_text(value: str, *, field: str, max_length: int) -> str:
    normalized = value.strip()
    if not normalized:
        raise ProtocolValidationError(f"{field}不能为空")
    if len(normalized) > max_length:
        raise ProtocolValidationError(f"{field}不能超过{max_length}个字符")
    return normalized


def iso_timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def definition_view(
    definition: CollaborationProtocolDefinitionRecord,
    rules: Sequence[CollaborationProtocolRuleRecord],
) -> dict[str, Any]:
    return {
        "id": definition.id,
        "protocol_key": definition.protocol_key,
        "revision": definition.revision,
        "name": definition.name,
        "description": definition.description,
        "status": definition.status,
        "scenario_kinds": list(definition.scenario_kinds_json or []),
        "phases": list(definition.phases_json or []),
        "context_policy": dict(definition.context_policy_json or {}),
        "hitl_policy": dict(definition.hitl_policy_json or {}),
        "execution_policy": dict(definition.execution_policy_json or {}),
        "validation_policy": dict(definition.validation_policy_json or {}),
        "writeback_policy": dict(definition.writeback_policy_json or {}),
        "ui_schema": dict(definition.ui_schema_json or {}),
        "definition_hash": definition.definition_hash,
        "created_by": definition.created_by,
        "created_at": iso_timestamp(definition.created_at),
        "rules": [
            {
                "id": rule.id,
                "rule_key": rule.rule_key,
                "name": rule.name,
                "description": rule.description,
                "category": rule.category,
                "enforcement": rule.enforcement,
                "severity": rule.severity,
                "overridable": rule.overridable,
                "condition": dict(rule.condition_json or {}),
                "validator": dict(rule.validator_json or {}),
                "failure_action": rule.failure_action,
                "ordinal": rule.ordinal,
            }
            for rule in rules
        ],
    }


def binding_view(
    binding: CollaborationProtocolBindingRecord,
    definition: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "id": binding.id,
        "scope_id": binding.scope_id,
        "scope_kind": binding.scope_kind,
        "scope_ref_id": binding.scope_ref_id,
        "scenario_kind": binding.scenario_kind,
        "protocol_definition_id": binding.protocol_definition_id,
        "protocol_key": definition["protocol_key"],
        "protocol_revision": definition["revision"],
        "protocol_name": definition["name"],
        "parameter_overrides": dict(binding.parameter_overrides_json or {}),
        "disabled_rule_keys": list(binding.disabled_rule_keys_json or []),
        "status": binding.status,
        "row_version": binding.row_version,
        "created_by": binding.created_by,
        "created_at": iso_timestamp(binding.created_at),
        "updated_at": iso_timestamp(binding.updated_at),
    }


def definition_hash_payload(value: Mapping[str, Any]) -> dict[str, Any]:
    """Return only semantic fields so database IDs and timestamps do not alter the revision hash."""

    return {
        "protocol_key": value["protocol_key"],
        "revision": value["revision"],
        "name": value["name"],
        "description": value["description"],
        "status": value["status"],
        "scenario_kinds": value["scenario_kinds"],
        "phases": value["phases"],
        "context_policy": value["context_policy"],
        "hitl_policy": value["hitl_policy"],
        "execution_policy": value["execution_policy"],
        "validation_policy": value["validation_policy"],
        "writeback_policy": value["writeback_policy"],
        "ui_schema": value["ui_schema"],
        "rules": value["rules"],
    }

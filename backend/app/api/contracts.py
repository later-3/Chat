"""HTTP request contracts owned by the FastAPI adapter.

These models intentionally stay outside the product/application services.
They validate transport input and are translated into explicit service calls
by :mod:`backend.app.api.product_router`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ReviseModelCallDraftRequest(BaseModel):
    """Replace every editable field in one provider request draft."""

    model_config = ConfigDict(extra="forbid")

    expected_hash: str
    provider_id: str
    provider_request: dict[str, Any]


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = "新会话"
    model_provider_id: str | None = None
    model: str | None = None


class UpdateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    archived: bool | None = None
    model_provider_id: str | None = None
    model: str | None = None


class UpdateAgentProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int
    name: str
    description: str
    instructions: str
    provider_id: str
    model: str
    enabled: bool


class UpdatePiToolConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int
    enabled: bool
    provider_id: str
    model: str
    working_directory: str
    allowed_tools: list[str]
    thinking_level: str
    max_model_calls: int
    timeout_seconds: int
    system_prompt: str


class HitlPolicyRuleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_point_key: str
    mode: str
    condition: dict[str, Any] | None = None
    on_match: str | None = None
    constraints: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""


class ActivateHitlPolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope_kind: str
    scope_ref_id: str
    scope_ref_revision: str | None = None
    expected_active_revision_id: str | None = None
    change_summary: str = ""
    rules: list[HitlPolicyRuleRequest]


class PreviewHitlPolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_point_key: str
    scopes: list[dict[str, str]]
    facts: dict[str, Any] = Field(default_factory=dict)


class HumanDecisionItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_key: str
    decision: str


class ResolveHumanDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_request_hash: str
    expected_row_version: int
    item_decisions: list[HumanDecisionItemRequest]
    response_payload: dict[str, Any] = Field(default_factory=dict)


class ReviseExecutionDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision_id: str
    expected_draft_hash: str
    expected_row_version: int
    execution_brief: str
    payload: dict[str, Any]

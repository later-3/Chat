"""REST boundary for Evidence completion claims (SD4-C Result Commit Gate).

The commit endpoint is the only user-reachable Evidence mutation: creating
Observations, Assessments, ValidationRuns or outcomes is service-internal
(§13.1) and intentionally has no public route, so a browser cannot forge
Evidence rows (failure matrix 19).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..evidence.contracts import EvidenceError
from ..evidence.result_commit import ResultCommitCoordinator
from ..harness.contracts import HarnessError
from .errors import http_problem, problem_responses
from .identifiers import CommandId


class CommitResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: CommandId
    claim_hash: str = Field(min_length=64, max_length=64)
    expected_claim_row_version: int = Field(ge=1)
    decision_record_id: str = Field(min_length=1, max_length=36)
    commit_status: str
    artifact_disposition: str


def create_evidence_router(coordinator: ResultCommitCoordinator) -> APIRouter:
    """Create the Evidence router without taking ownership of state."""

    router = APIRouter(prefix="/api/evidence", tags=["evidence"])

    @router.post(
        "/claims/{claim_id}/commit",
        responses=problem_responses(),
    )
    async def commit_claim(claim_id: str, command: CommitResultRequest) -> dict[str, Any]:
        try:
            return await coordinator.commit_result(
                claim_id=claim_id,
                claim_hash=command.claim_hash,
                expected_claim_row_version=command.expected_claim_row_version,
                decision_record_id=command.decision_record_id,
                commit_status=command.commit_status,
                artifact_disposition=command.artifact_disposition,
                command_id=command.command_id,
            )
        except EvidenceError as error:
            raise http_problem(status_code=error.http_status, error=error) from error
        except HarnessError as error:
            raise http_problem(status_code=409, error=error) from error

    @router.get(
        "/claims/{claim_id}",
        responses=problem_responses(),
    )
    async def get_claim(claim_id: str) -> dict[str, Any]:
        try:
            return await coordinator.claim_view(claim_id)
        except EvidenceError as error:
            raise http_problem(status_code=error.http_status, error=error) from error
        except HarnessError as error:
            raise http_problem(status_code=409, error=error) from error

    return router

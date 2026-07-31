"""W1-01 public ID, error-family and recovery-action contract tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.api import (
    IdentifierKind,
    PublicIdentifierInvalid,
    RecoveryAction,
    public_error_spec,
    short_public_id,
    validate_public_id,
)

APP_ROOT = Path(__file__).resolve().parents[1] / "app"


@pytest.mark.parametrize(
    "value",
    [
        "0b9a0af8-0983-4e9b-bcbf-87dc2d463041",
        "project:2026.07.31",
        "command_retry-1",
    ],
)
def test_public_id_syntax_preserves_opaque_stable_values(value: str) -> None:
    assert validate_public_id(value, kind=IdentifierKind.RESOURCE) == value
    assert short_public_id(value) == value[:8]


@pytest.mark.parametrize("value", ["", "../private", "id with spaces", "项目-1", "x" * 161])
def test_public_id_syntax_rejects_paths_display_text_and_oversize_values(value: str) -> None:
    with pytest.raises(PublicIdentifierInvalid):
        validate_public_id(value, kind=IdentifierKind.COMMAND)


def test_public_error_families_drive_ui_recovery_without_message_parsing() -> None:
    assert public_error_spec("SESSION_NOT_FOUND", 404).recovery_action is RecoveryAction.GO_BACK
    assert public_error_spec("SESSION_CONFLICT", 409).recovery_action is RecoveryAction.REFRESH
    assert public_error_spec("SERVICE_UNAVAILABLE", 503).retryable is True

    unknown = public_error_spec("TOOL_OPERATION_OUTCOME_UNKNOWN", 409)
    assert unknown.retryable is False
    assert unknown.recovery_action is RecoveryAction.RECONCILE

    stale = public_error_spec("CONTEXT_SOURCE_STALE", 409)
    assert stale.retryable is False
    assert stale.recovery_action is RecoveryAction.REFRESH


def test_every_rest_command_id_uses_the_shared_transport_type() -> None:
    violations: list[str] = []
    for path in APP_ROOT.rglob("*api.py"):
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if "command_id:" in line and "CommandId" not in line:
                violations.append(f"{path.relative_to(APP_ROOT)}:{line_number}")
    for path in APP_ROOT.rglob("*router.py"):
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if "command_id:" in line and "CommandId" not in line:
                violations.append(f"{path.relative_to(APP_ROOT)}:{line_number}")

    assert violations == []

"""Machine-readable public error families for REST callers and UI recovery."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final


class RecoveryAction(StrEnum):
    """Stable caller action; localized messages are never program branches."""

    REVIEW = "review"
    AUTHENTICATE = "authenticate"
    FORBIDDEN = "forbidden"
    GO_BACK = "go_back"
    REFRESH = "refresh"
    EXPIRED = "expired"
    RETRY = "retry"
    RECONCILE = "reconcile"
    CONTACT_SUPPORT = "contact_support"


@dataclass(frozen=True, slots=True)
class PublicErrorSpec:
    """Network mapping inherited by concrete module-owned error codes."""

    http_status: int
    retryable: bool
    recovery_action: RecoveryAction
    public_detail_keys: frozenset[str]
    log_level: str


PUBLIC_DETAIL_KEYS: Final = frozenset(
    {
        "actual_revision",
        "expected_revision",
        "field",
        "issues",
        "next_cursor",
        "resource_id",
        "resource_kind",
    }
)


def _spec(
    status: int,
    action: RecoveryAction,
    *,
    retryable: bool = False,
    log_level: str = "info",
) -> PublicErrorSpec:
    return PublicErrorSpec(
        http_status=status,
        retryable=retryable,
        recovery_action=action,
        public_detail_keys=PUBLIC_DETAIL_KEYS,
        log_level=log_level,
    )


STATUS_ERROR_SPECS: Final = MappingProxyType(
    {
        400: _spec(400, RecoveryAction.REVIEW),
        401: _spec(401, RecoveryAction.AUTHENTICATE, log_level="warning"),
        403: _spec(403, RecoveryAction.FORBIDDEN, log_level="warning"),
        404: _spec(404, RecoveryAction.GO_BACK),
        409: _spec(409, RecoveryAction.REFRESH),
        410: _spec(410, RecoveryAction.EXPIRED),
        422: _spec(422, RecoveryAction.REVIEW),
        429: _spec(429, RecoveryAction.RETRY, retryable=True, log_level="warning"),
        500: _spec(500, RecoveryAction.CONTACT_SUPPORT, log_level="error"),
        502: _spec(502, RecoveryAction.RETRY, retryable=True, log_level="warning"),
        503: _spec(503, RecoveryAction.RETRY, retryable=True, log_level="warning"),
        504: _spec(504, RecoveryAction.RETRY, retryable=True, log_level="warning"),
    }
)

# Exact entries document the product-wide fallbacks and exceptional semantics.
# Module-owned codes inherit the status family unless they need an override.
REGISTERED_ERROR_CODES: Final = MappingProxyType(
    {
        "REQUEST_INVALID": STATUS_ERROR_SPECS[400],
        "AUTHENTICATION_REQUIRED": STATUS_ERROR_SPECS[401],
        "PERMISSION_DENIED": STATUS_ERROR_SPECS[403],
        "RESOURCE_NOT_FOUND": STATUS_ERROR_SPECS[404],
        "RESOURCE_CONFLICT": STATUS_ERROR_SPECS[409],
        "RESOURCE_EXPIRED": STATUS_ERROR_SPECS[410],
        "REQUEST_VALIDATION_FAILED": STATUS_ERROR_SPECS[422],
        "RATE_LIMITED": STATUS_ERROR_SPECS[429],
        "INTERNAL_SERVER_ERROR": STATUS_ERROR_SPECS[500],
        "UPSTREAM_SERVICE_ERROR": STATUS_ERROR_SPECS[502],
        "SERVICE_UNAVAILABLE": STATUS_ERROR_SPECS[503],
        "UPSTREAM_TIMEOUT": STATUS_ERROR_SPECS[504],
        "OUTCOME_UNKNOWN": _spec(409, RecoveryAction.RECONCILE, log_level="warning"),
        "STALE_SOURCE": _spec(409, RecoveryAction.REFRESH),
    }
)


def public_error_spec(code: str, status_code: int) -> PublicErrorSpec:
    """Resolve exact semantics, exceptional suffixes, then the HTTP family."""

    exact = REGISTERED_ERROR_CODES.get(code)
    if exact is not None and exact.http_status == status_code:
        return exact
    if code == "OUTCOME_UNKNOWN" or code.endswith("_OUTCOME_UNKNOWN"):
        base = STATUS_ERROR_SPECS.get(status_code, STATUS_ERROR_SPECS[500])
        return PublicErrorSpec(
            http_status=status_code,
            retryable=False,
            recovery_action=RecoveryAction.RECONCILE,
            public_detail_keys=base.public_detail_keys,
            log_level="warning",
        )
    if code == "STALE_SOURCE" or code.endswith("_STALE"):
        base = STATUS_ERROR_SPECS.get(status_code, STATUS_ERROR_SPECS[409])
        return PublicErrorSpec(
            http_status=status_code,
            retryable=False,
            recovery_action=RecoveryAction.REFRESH,
            public_detail_keys=base.public_detail_keys,
            log_level=base.log_level,
        )
    return STATUS_ERROR_SPECS.get(status_code, STATUS_ERROR_SPECS[500])

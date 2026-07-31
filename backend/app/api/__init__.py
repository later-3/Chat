"""HTTP boundary contracts shared by Product REST endpoints."""

from .error_registry import PublicErrorSpec, RecoveryAction, public_error_spec
from .errors import (
    ProblemDetail,
    http_problem,
    install_error_handlers,
    problem_responses,
)
from .identifiers import (
    CommandId,
    IdentifierKind,
    PublicIdentifierInvalid,
    PublicResourceId,
    short_public_id,
    validate_public_id,
)
from .request_context import CorrelationMiddleware, current_request_id

__all__ = [
    "CorrelationMiddleware",
    "CommandId",
    "IdentifierKind",
    "ProblemDetail",
    "PublicErrorSpec",
    "PublicIdentifierInvalid",
    "PublicResourceId",
    "RecoveryAction",
    "current_request_id",
    "http_problem",
    "install_error_handlers",
    "problem_responses",
    "public_error_spec",
    "short_public_id",
    "validate_public_id",
]

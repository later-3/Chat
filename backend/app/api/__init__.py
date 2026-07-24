"""HTTP boundary contracts shared by Product REST endpoints."""

from .errors import (
    ProblemDetail,
    http_problem,
    install_error_handlers,
    problem_responses,
)
from .request_context import CorrelationMiddleware, current_request_id

__all__ = [
    "CorrelationMiddleware",
    "ProblemDetail",
    "current_request_id",
    "http_problem",
    "install_error_handlers",
    "problem_responses",
]

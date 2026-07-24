"""Correlation fields propagated across HTTP, Workflow and Worker boundaries."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

CORRELATION_FIELDS = (
    "request_id",
    "principal_id",
    "session_id",
    "interaction_id",
    "product_run_id",
    "attempt_id",
    "job_id",
    "workflow_id",
    "executor_id",
    "execution_request_id",
    "decision_request_id",
    "checkpoint_id",
    "command_id",
    "resource_id",
    "worker_id",
)
_context: ContextVar[dict[str, str] | None] = ContextVar(
    "chat_correlation_context",
    default=None,
)


def correlation_fields() -> dict[str, str]:
    """Return a copy of the current whitelisted correlation context."""

    return dict(_context.get() or {})


@contextmanager
def bind_context(**fields: Any) -> Iterator[dict[str, str]]:
    """Temporarily add non-secret identifiers to the current context."""

    current = correlation_fields()
    additions = {
        key: str(value)[:200]
        for key, value in fields.items()
        if key in CORRELATION_FIELDS and value is not None and str(value)
    }
    next_context = {**current, **additions}
    token = _context.set(next_context)
    try:
        yield next_context
    finally:
        _context.reset(token)

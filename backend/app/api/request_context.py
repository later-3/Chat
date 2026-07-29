"""Request-scoped correlation without making HTTP state a product fact."""

from __future__ import annotations

import logging
import re
import time
import uuid
from contextvars import ContextVar, Token

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..observability.context import bind_context
from ..observability.metrics import metrics
from ..observability.tracing import tracer

REQUEST_ID_HEADER = b"x-request-id"
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_request_id: ContextVar[str | None] = ContextVar("chat_request_id", default=None)
logger = logging.getLogger(__name__)
_HIGH_FREQUENCY_READ_PATHS = {
    "/api/health",
    "/api/live",
    "/api/hitl/decision-requests",
}
_HIGH_FREQUENCY_READ_PATTERNS = (
    re.compile(r"^/api/runs/[^/]+/governance$"),
    re.compile(r"^/api/sessions/[^/]+/runs/[^/]+/(?:trace|trace-reports)$"),
    re.compile(r"^/api/runtime/product-runs/[^/]+$"),
)


def is_high_frequency_read(method: str, path: str) -> bool:
    """Return whether a read is expected to be polled while a Run is active."""

    return method == "GET" and (
        path in _HIGH_FREQUENCY_READ_PATHS
        or path.endswith("/events")
        or any(pattern.fullmatch(path) for pattern in _HIGH_FREQUENCY_READ_PATTERNS)
    )


def _request_log(method: str, path: str):
    """Keep polling visible to metrics without flooding durable INFO logs."""

    if is_high_frequency_read(method, path):
        return logger.debug
    return logger.info


def current_request_id() -> str:
    """Return the current transport correlation id or create a local one."""

    return _request_id.get() or str(uuid.uuid4())


def _header_request_id(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name.lower() != REQUEST_ID_HEADER:
            continue
        try:
            candidate = value.decode("ascii")
        except UnicodeDecodeError:
            return None
        return candidate if _SAFE_REQUEST_ID.fullmatch(candidate) else None
    return None


class CorrelationMiddleware:
    """Attach one safe request id for the complete ASGI response lifecycle.

    The middleware remains active until a streaming response finishes, unlike a
    request/response callback that resets ContextVar state as soon as the
    ``StreamingResponse`` object is created.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        request_id = _header_request_id(scope) or str(uuid.uuid4())
        token: Token[str | None] = _request_id.set(request_id)
        scope.setdefault("state", {})["request_id"] = request_id
        method = str(scope.get("method") or scope["type"]).upper()
        path = str(scope.get("path") or "")
        response_status = 500
        started = time.perf_counter()
        log_event = _request_log(method, path)

        async def send_with_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                nonlocal response_status
                response_status = int(message["status"])
                headers = list(message.get("headers", []))
                headers = [(name, value) for name, value in headers if name.lower() != REQUEST_ID_HEADER]
                headers.append((REQUEST_ID_HEADER, request_id.encode("ascii")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            with bind_context(request_id=request_id):
                with tracer().start_as_current_span(
                    "http.request",
                    attributes={
                        "http.request.method": method,
                        "url.path": path,
                    },
                ) as span:
                    log_event("http_request_started method=%s path=%s", method, path)
                    try:
                        await self.app(scope, receive, send_with_request_id)
                    except Exception as error:
                        span.set_attribute("error.type", type(error).__name__)
                        raise
                    finally:
                        duration = time.perf_counter() - started
                        span.set_attribute("http.response.status_code", response_status)
                        metrics.increment("http.server.requests")
                        if response_status >= 500:
                            metrics.increment("http.server.errors")
                        metrics.observe("http.server.duration_seconds", duration)
                        log_event(
                            "http_request_finished method=%s path=%s status=%d duration_ms=%.3f",
                            method,
                            path,
                            response_status,
                            duration * 1000,
                        )
        finally:
            _request_id.reset(token)

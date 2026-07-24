"""Stable, redacted REST error contracts for every FastAPI boundary."""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette import status

from .request_context import current_request_id

logger = logging.getLogger(__name__)

_ABSOLUTE_PATH = re.compile(
    r"(?<![A-Za-z0-9])(?:/(?:Users|home|private|tmp|var|opt|etc)/[^\s，。；;,)]+|[A-Za-z]:\\[^\s，。；;,)]+)"
)
_SECRET = re.compile(
    r"(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~-]{12,}\b)",
    re.IGNORECASE,
)
_SQL = re.compile(
    r"\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b.{0,240}",
    re.IGNORECASE,
)
_CODE_PART = re.compile(r"[^A-Za-z0-9]+")

_STATUS_CODE = {
    status.HTTP_400_BAD_REQUEST: "REQUEST_INVALID",
    status.HTTP_401_UNAUTHORIZED: "AUTHENTICATION_REQUIRED",
    status.HTTP_403_FORBIDDEN: "PERMISSION_DENIED",
    status.HTTP_404_NOT_FOUND: "RESOURCE_NOT_FOUND",
    status.HTTP_409_CONFLICT: "RESOURCE_CONFLICT",
    status.HTTP_410_GONE: "RESOURCE_EXPIRED",
    status.HTTP_422_UNPROCESSABLE_CONTENT: "REQUEST_VALIDATION_FAILED",
    status.HTTP_429_TOO_MANY_REQUESTS: "RATE_LIMITED",
    status.HTTP_500_INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
    status.HTTP_502_BAD_GATEWAY: "UPSTREAM_SERVICE_ERROR",
    status.HTTP_503_SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    status.HTTP_504_GATEWAY_TIMEOUT: "UPSTREAM_TIMEOUT",
}
_SERVER_MESSAGE = {
    status.HTTP_500_INTERNAL_SERVER_ERROR: "服务处理请求时发生内部错误。",
    status.HTTP_502_BAD_GATEWAY: "上游服务暂时不可用或返回了无效结果。",
    status.HTTP_503_SERVICE_UNAVAILABLE: "服务暂时不可用，请稍后重试。",
    status.HTTP_504_GATEWAY_TIMEOUT: "等待上游服务响应超时。",
}
_DETAIL_KEYS = {
    "actual_revision",
    "expected_revision",
    "field",
    "issues",
    "next_cursor",
    "resource_id",
}


class ProblemDetail(BaseModel):
    """Versioned public error envelope; internal exceptions never cross it."""

    model_config = ConfigDict(extra="forbid")

    code: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")
    message: str
    request_id: str
    retryable: bool
    details: dict[str, Any] | None = None


def problem_responses() -> dict[int | str, dict[str, Any]]:
    """OpenAPI response declarations shared by every REST route."""

    return {
        code: {"model": ProblemDetail, "description": description}
        for code, description in {
            400: "Invalid request",
            401: "Authentication required",
            403: "Permission denied",
            404: "Resource not found",
            409: "Version or state conflict",
            410: "Resource or cursor expired",
            422: "Request validation failed",
            429: "Rate limited",
            500: "Internal service error",
            502: "Upstream service error",
            503: "Service unavailable",
            504: "Upstream timeout",
        }.items()
    }


def http_problem(
    *,
    status_code: int,
    error: BaseException | None = None,
    code: str | None = None,
    message: str | None = None,
    details: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> HTTPException:
    """Build an HTTP exception without leaking an unstructured ``detail``."""

    resolved_code = _normalize_code(
        code or getattr(error, "code", None) or getattr(error, "error_code", None),
        status_code,
    )
    payload: dict[str, Any] = {
        "code": resolved_code,
        "message": message or (str(error) if error is not None else ""),
    }
    if details:
        payload.update(details)
    return HTTPException(
        status_code=status_code,
        detail=payload,
        headers=dict(headers or {}),
    )


def _normalize_code(value: Any, status_code: int) -> str:
    if isinstance(value, str) and value.strip():
        normalized = _CODE_PART.sub("_", value.strip()).strip("_").upper()
        if normalized:
            return normalized[:100]
    return _STATUS_CODE.get(status_code, "REQUEST_FAILED")


def _exception_code(error: BaseException | None, status_code: int) -> str:
    if error is None:
        return _STATUS_CODE.get(status_code, "REQUEST_FAILED")
    return _normalize_code(
        getattr(error, "code", None) or getattr(error, "error_code", None),
        status_code,
    )


def _redact(value: str) -> str:
    redacted = _SECRET.sub("[redacted-secret]", value)
    redacted = _ABSOLUTE_PATH.sub("[redacted-path]", redacted)
    redacted = _SQL.sub("[redacted-query]", redacted)
    return redacted[:500]


def _safe_detail(value: Any) -> Any:
    if isinstance(value, str):
        return _redact(value)
    if isinstance(value, bool | int | float) or value is None:
        return value
    if isinstance(value, Sequence) and not isinstance(value, bytes | bytearray | str):
        return [_safe_detail(item) for item in list(value)[:50]]
    if isinstance(value, Mapping):
        return {str(key)[:80]: _safe_detail(item) for key, item in list(value.items())[:50]}
    return _redact(str(value))


def _details(detail: Any) -> dict[str, Any] | None:
    if not isinstance(detail, Mapping):
        return None
    result = {str(key): _safe_detail(value) for key, value in detail.items() if key in _DETAIL_KEYS}
    return result or None


def _message(detail: Any, status_code: int) -> str:
    if status_code >= 500:
        return _SERVER_MESSAGE.get(status_code, _SERVER_MESSAGE[500])
    if isinstance(detail, str) and detail.strip():
        return _redact(detail.strip())
    if isinstance(detail, Mapping):
        message = detail.get("message")
        if isinstance(message, str) and message.strip():
            return _redact(message.strip())
    return {
        400: "请求无效。",
        401: "需要有效身份后才能继续。",
        403: "当前身份没有执行此操作的权限。",
        404: "请求的资源不存在。",
        409: "资源版本或状态已变化，请刷新后重试。",
        410: "请求的资源或游标已经失效。",
        422: "请求内容未通过校验。",
        429: "请求过于频繁，请稍后重试。",
    }.get(status_code, "请求处理失败。")


def _retryable(
    status_code: int,
    code: str,
    *,
    cause: BaseException | None = None,
) -> bool:
    if "OUTCOME_UNKNOWN" in code or getattr(cause, "outcome_status", None) == "outcome_unknown":
        return False
    return status_code in {429, 502, 503, 504}


def _response(
    *,
    status_code: int,
    code: str,
    message: str,
    request_id: str,
    retryable: bool,
    details: dict[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    problem = ProblemDetail(
        code=code,
        message=message,
        request_id=request_id,
        retryable=retryable,
        details=details,
    )
    response_headers = dict(headers or {})
    response_headers["X-Request-ID"] = request_id
    return JSONResponse(
        status_code=status_code,
        content=problem.model_dump(mode="json"),
        headers=response_headers,
    )


def install_error_handlers(app: FastAPI) -> None:
    """Install one fail-closed mapping for framework and application errors."""

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, error: HTTPException) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None) or current_request_id()
        cause = error.__cause__
        detail_code = error.detail.get("code") if isinstance(error.detail, Mapping) else None
        code = _normalize_code(
            detail_code or getattr(cause, "code", None) or getattr(cause, "error_code", None),
            error.status_code,
        )
        return _response(
            status_code=error.status_code,
            code=code,
            message=_message(error.detail, error.status_code),
            request_id=request_id,
            retryable=_retryable(error.status_code, code, cause=cause),
            details=_details(error.detail),
            headers=error.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(
        request: Request,
        error: RequestValidationError,
    ) -> JSONResponse:
        issues = [
            {
                "path": ".".join(str(item) for item in issue.get("loc", ())),
                "type": str(issue.get("type") or "validation_error"),
                "message": _redact(str(issue.get("msg") or "请求字段无效")),
            }
            for issue in error.errors()[:50]
        ]
        return _response(
            status_code=422,
            code="REQUEST_VALIDATION_FAILED",
            message="请求内容未通过校验。",
            request_id=getattr(request.state, "request_id", None) or current_request_id(),
            retryable=False,
            details={"issues": issues},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, error: Exception) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None) or current_request_id()
        # The public response is deliberately generic. Q04's redacting logger
        # owns stack details; until then never interpolate the exception value.
        logger.error(
            "unhandled_http_exception request_id=%s error_type=%s",
            request_id,
            type(error).__name__,
        )
        return _response(
            status_code=500,
            code=_exception_code(error, 500),
            message=_SERVER_MESSAGE[500],
            request_id=request_id,
            retryable=False,
        )

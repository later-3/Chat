"""Structured logging with correlation-field whitelisting and redaction."""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from typing import Any

from opentelemetry import trace

from ..config import ObservabilitySettings
from .context import CORRELATION_FIELDS, correlation_fields
from .tracing import configure_tracing

_PATH = re.compile(
    r"(?<![A-Za-z0-9])(?:/(?:Users|home|private|tmp|var|opt|etc)/[^\s，。；;,)]+|[A-Za-z]:\\[^\s，。；;,)]+)"
)
_SECRET = re.compile(
    r"(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~-]{12,}\b)",
    re.IGNORECASE,
)
_SENSITIVE_FIELD = re.compile(
    r"""(["']?(?:api[_-]?key|authorization|content|instructions|input|prompt|provider_body)["']?\s*[:=]\s*)(["'])(.*?)(\2)""",
    re.IGNORECASE,
)
_SQL = re.compile(
    r"\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b.{0,500}",
    re.IGNORECASE,
)
_configure_lock = threading.Lock()
_configured_signature: tuple[str, str, str | None, int, int] | None = None


def redact_text(value: str) -> str:
    """Remove common secret, private path, SQL and content-shaped values."""

    redacted = _SECRET.sub("[redacted-secret]", value)
    redacted = _PATH.sub("[redacted-path]", redacted)
    redacted = _SENSITIVE_FIELD.sub(r"\1\2[redacted-content]\2", redacted)
    redacted = _SQL.sub("[redacted-query]", redacted)
    return redacted


def _trace_fields() -> dict[str, str]:
    span_context = trace.get_current_span().get_span_context()
    if not span_context.is_valid:
        return {}
    return {
        "trace_id": f"{span_context.trace_id:032x}",
        "span_id": f"{span_context.span_id:016x}",
    }


class CorrelatedFormatter(logging.Formatter):
    """Render either readable console logs or one-line JSON records."""

    def __init__(self, *, json_format: bool) -> None:
        super().__init__()
        self.json_format = json_format

    def format(self, record: logging.LogRecord) -> str:
        message = redact_text(record.getMessage())
        fields = {
            **correlation_fields(),
            **_trace_fields(),
        }
        for field in CORRELATION_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                fields[field] = str(value)[:200]
        if record.exc_info:
            exception = redact_text(self.formatException(record.exc_info))
        else:
            exception = None

        if self.json_format:
            payload: dict[str, Any] = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "level": record.levelname,
                "logger": record.name,
                "event": message,
                **fields,
            }
            if exception:
                payload["exception"] = exception
            return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

        prefix = " ".join(f"{key}={value}" for key, value in fields.items())
        rendered = f"{record.levelname} {record.name} {message}"
        if prefix:
            rendered = f"{rendered} {prefix}"
        if exception:
            rendered = f"{rendered}\n{exception}"
        return rendered


def configure_observability(settings: ObservabilitySettings) -> None:
    """Configure one process-wide safe logger and local OTel provider."""

    global _configured_signature
    signature = (
        settings.log_level,
        settings.log_format,
        str(settings.log_file) if settings.log_file is not None else None,
        settings.log_max_bytes,
        settings.log_backup_count,
    )
    with _configure_lock:
        configure_tracing()
        if _configured_signature == signature:
            return
        console_handler = logging.StreamHandler(sys.stderr)
        console_handler.setFormatter(CorrelatedFormatter(json_format=settings.log_format == "json"))
        handlers: list[logging.Handler] = [console_handler]
        if settings.log_file is not None:
            settings.log_file.parent.mkdir(parents=True, exist_ok=True)
            file_handler = RotatingFileHandler(
                settings.log_file,
                maxBytes=settings.log_max_bytes,
                backupCount=settings.log_backup_count,
                encoding="utf-8",
                delay=True,
            )
            # Persistent files are always machine-searchable JSONL, independent
            # of the human-readable console format.
            file_handler.setFormatter(CorrelatedFormatter(json_format=True))
            handlers.append(file_handler)
        root = logging.getLogger()
        root.handlers[:] = handlers
        root.setLevel(getattr(logging, settings.log_level))
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)
        _configured_signature = signature

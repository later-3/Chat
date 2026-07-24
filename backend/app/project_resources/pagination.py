"""Opaque, scope-bound cursors for repository directory and Snapshot pages."""

from __future__ import annotations

import base64
import json
from typing import Any

from .contracts import ProjectResourceValidationError


def encode_cursor(payload: dict[str, Any]) -> str:
    body = json.dumps(
        {"v": 1, **payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")


def decode_cursor(value: str | None, *, kind: str) -> dict[str, Any] | None:
    if value is None:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))
        payload = json.loads(decoded.decode("utf-8"))
    except (UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise ProjectResourceValidationError(
            "Repository分页游标无效",
            code="REPOSITORY_CURSOR_INVALID",
        ) from error
    if not isinstance(payload, dict) or payload.get("v") != 1 or payload.get("kind") != kind:
        raise ProjectResourceValidationError(
            "Repository分页游标无效",
            code="REPOSITORY_CURSOR_INVALID",
        )
    return payload

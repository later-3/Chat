"""Transport syntax for opaque IDs; identity and authorization stay separate."""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, TypeAlias

from pydantic import StringConstraints, TypeAdapter, ValidationError

_PUBLIC_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$"

PublicResourceId: TypeAlias = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=160, pattern=_PUBLIC_ID_PATTERN),
]
CommandId: TypeAlias = PublicResourceId


class IdentifierKind(StrEnum):
    """Semantic kind for diagnostics; no ID kind grants access by itself."""

    COMMAND = "command_id"
    RESOURCE = "resource_id"
    CORRELATION = "correlation_id"


class PublicIdentifierInvalid(ValueError):
    """An external identifier is unsafe or outside the stable transport shape."""

    code = "PUBLIC_IDENTIFIER_INVALID"

    def __init__(self, kind: IdentifierKind) -> None:
        super().__init__(f"{kind.value}格式无效")
        self.kind = kind


_PUBLIC_ID_ADAPTER = TypeAdapter(PublicResourceId)


def validate_public_id(value: str, *, kind: IdentifierKind) -> str:
    """Validate syntax only; callers must still enforce Scope and existence."""

    try:
        return _PUBLIC_ID_ADAPTER.validate_python(value)
    except ValidationError as error:
        raise PublicIdentifierInvalid(kind) from error


def short_public_id(value: str, *, length: int = 8) -> str:
    """Create a display locator without changing the complete canonical ID."""

    validated = validate_public_id(value, kind=IdentifierKind.RESOURCE)
    return validated if len(validated) <= length else validated[:length]

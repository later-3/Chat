"""Startup-owned allowlist for filesystem roots.

The catalog is configuration, not Product state. It deliberately separates a
safe public label/key projection from the resolved path used by adapters.
"""

from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ..config import WorkspaceRootSettings
from .contracts import (
    ProjectResourceNotFound,
    ProjectResourceValidationError,
    sha256_json,
)


def _is_reparse_point(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def root_identity_hash(path: Path) -> str:
    """Produce a stable opaque identity without exposing the source path."""

    return hashlib.sha256(os.fsencode(str(path))).hexdigest()


@dataclass(frozen=True, slots=True)
class WorkspaceRoot:
    """One catalog entry, including private adapter-only fields."""

    key: str
    label: str
    configured_path: Path
    resolved_root: Path | None
    identity_hash: str | None
    available: bool
    source: str
    error_code: str | None = None

    def public_view(self) -> dict[str, Any]:
        return {
            "root_key": self.key,
            "label": self.label,
            "available": self.available,
            "source": self.source,
            "error_code": self.error_code,
        }


class WorkspaceRootCatalog:
    """Immutable process snapshot of configured, validated workspace roots."""

    def __init__(self, roots: Iterable[WorkspaceRootSettings]) -> None:
        entries = tuple(self._inspect(value) for value in roots)
        self._roots = {entry.key: entry for entry in entries}
        if len(self._roots) != len(entries):
            raise ProjectResourceValidationError(
                "Workspace Root Key重复",
                code="REPOSITORY_ROOT_KEY_DUPLICATED",
            )
        self.revision = sha256_json(
            {
                "schema": "workspace-root-catalog-v1",
                "roots": [
                    {
                        "key": value.key,
                        "identity_hash": value.identity_hash or "",
                        "available": value.available,
                        "source": value.source,
                    }
                    for value in sorted(entries, key=lambda item: item.key)
                ],
            }
        )

    @staticmethod
    def _inspect(value: WorkspaceRootSettings) -> WorkspaceRoot:
        configured = value.path
        try:
            metadata = configured.lstat()
        except FileNotFoundError:
            return WorkspaceRoot(
                key=value.key,
                label=value.label,
                configured_path=configured,
                resolved_root=None,
                identity_hash=None,
                available=False,
                source=value.source,
                error_code="REPOSITORY_ROOT_UNAVAILABLE",
            )
        except OSError:
            return WorkspaceRoot(
                key=value.key,
                label=value.label,
                configured_path=configured,
                resolved_root=None,
                identity_hash=None,
                available=False,
                source=value.source,
                error_code="REPOSITORY_ROOT_UNREADABLE",
            )
        if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata):
            return WorkspaceRoot(
                key=value.key,
                label=value.label,
                configured_path=configured,
                resolved_root=None,
                identity_hash=None,
                available=False,
                source=value.source,
                error_code="REPOSITORY_SYMLINK_REJECTED",
            )
        if not stat.S_ISDIR(metadata.st_mode) or not os.access(configured, os.R_OK | os.X_OK):
            return WorkspaceRoot(
                key=value.key,
                label=value.label,
                configured_path=configured,
                resolved_root=None,
                identity_hash=None,
                available=False,
                source=value.source,
                error_code="REPOSITORY_ROOT_UNREADABLE",
            )
        try:
            resolved = configured.resolve(strict=True)
        except OSError:
            return WorkspaceRoot(
                key=value.key,
                label=value.label,
                configured_path=configured,
                resolved_root=None,
                identity_hash=None,
                available=False,
                source=value.source,
                error_code="REPOSITORY_ROOT_UNREADABLE",
            )
        return WorkspaceRoot(
            key=value.key,
            label=value.label,
            configured_path=configured,
            resolved_root=resolved,
            identity_hash=root_identity_hash(resolved),
            available=True,
            source=value.source,
        )

    def list_public(self) -> list[dict[str, Any]]:
        return [
            self._roots[key].public_view()
            for key in sorted(self._roots, key=lambda value: (self._roots[value].label, value))
        ]

    def get(self, key: str) -> WorkspaceRoot | None:
        return self._roots.get(key)

    def require_available(self, key: str) -> WorkspaceRoot:
        root = self._roots.get(key)
        if root is None:
            raise ProjectResourceNotFound(
                "Workspace Root不存在",
                code="REPOSITORY_ROOT_NOT_FOUND",
            )
        if not root.available or root.resolved_root is None or root.identity_hash is None:
            raise ProjectResourceValidationError(
                "Workspace Root当前不可用",
                code=root.error_code or "REPOSITORY_ROOT_UNAVAILABLE",
            )
        return root

    def identity_for(self, key: str) -> str | None:
        root = self._roots.get(key)
        return root.identity_hash if root and root.available else None

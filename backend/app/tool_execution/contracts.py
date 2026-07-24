"""Stable contracts shared by Tool Operation coordination and policy code."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

TOOL_DEFINITION_REVISION = "chat-exact-edit-v1"
MAX_EDIT_FILE_BYTES = 1024 * 1024
MAX_EDIT_TEXT_CHARS = 256 * 1024
MAX_DIFF_PREVIEW_CHARS = 16 * 1024
PROTECTED_WRITE_PATTERNS = (
    ".git",
    ".git/*",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".pypirc",
    "credentials*.json",
    "backend/config.json",
)


class ToolOperationError(RuntimeError):
    """Safe Tool Operation failure with a stable code."""

    def __init__(self, message: str, *, code: str) -> None:
        self.code = code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class PreparedToolOperation:
    """Publicly reviewable projection of one exact edit proposal."""

    operation_id: str
    operation_hash: str
    arguments_hash: str
    workspace_id: str
    target_path: str
    expected_preimage_hash: str
    expected_postimage_hash: str
    diff_preview: str
    status: str

    def public_view(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "operation_hash": self.operation_hash,
            "arguments_hash": self.arguments_hash,
            "workspace_id": self.workspace_id,
            "target_path": self.target_path,
            "expected_preimage_hash": self.expected_preimage_hash,
            "expected_postimage_hash": self.expected_postimage_hash,
            "diff_preview": self.diff_preview,
            "status": self.status,
        }

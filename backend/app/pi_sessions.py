"""Chat 托管 pi Runtime Session 的创建、公开映射与终态冻结。

这里保存的是一次 ``ToolExecution`` 的 pi JSONL 转录证据，不是 Product Session、
MAF AgentSession 或 Workflow Checkpoint。Chat 每次执行只创建新文件，从不在这里
选择历史 Session 或提供续跑能力。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PI_SESSION_FORMAT_VERSION = 3
CHAT_PI_SESSION_PREFIX = "chat-"
_PI_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


class ChatPiSessionError(RuntimeError):
    """无法安全创建或冻结 Chat 托管 pi Session。"""

    code = "pi_session_persistence_failed"


def session_id_for_tool_execution(tool_execution_id: str) -> str:
    """生成可由 pi 原生 SessionManager 接受的稳定 Session ID。"""

    candidate = f"{CHAT_PI_SESSION_PREFIX}{tool_execution_id.strip()}"
    if _PI_SESSION_ID_PATTERN.fullmatch(candidate):
        return candidate
    digest = hashlib.sha256(tool_execution_id.encode("utf-8")).hexdigest()
    return f"{CHAT_PI_SESSION_PREFIX}{digest}"


def session_display_name(
    *,
    product_session_id: str | None,
    product_run_id: str | None,
    tool_execution_id: str,
) -> str:
    """生成只含公开 ID 短标识的名称，避免把 Prompt 或宿主机路径写进列表。"""

    def short(value: str | None) -> str:
        clean = " ".join((value or "unknown").split())
        return clean[:12]

    return (
        f"Chat托管 · PS {short(product_session_id)} · "
        f"Run {short(product_run_id)} · Tool {short(tool_execution_id)}"
    )


@dataclass(slots=True)
class ChatPiSession:
    """一个 ToolExecution 对应的、只新建不续跑的 pi Session 文件。"""

    id: str
    path: Path
    product_session_id: str | None
    product_run_id: str | None
    tool_execution_id: str
    name: str
    _frozen: bool = False

    def public_view(self) -> dict[str, Any]:
        """返回可写入 ToolExecution metrics 的安全关联，不暴露绝对路径。"""

        size = self.path.stat().st_size if self.path.is_file() else 0
        digest = _file_sha256(self.path) if self.path.is_file() else None
        return {
            "id": self.id,
            "source": "chat",
            "managed_by": "chat",
            "product_session_id": self.product_session_id,
            "product_run_id": self.product_run_id,
            "tool_execution_id": self.tool_execution_id,
            "storage": "dedicated_pi_session_directory",
            "auto_resume": False,
            "fork_enabled": False,
            "read_only": self._frozen,
            "state": "frozen" if self._frozen else "active",
            "bytes": size,
            "content_sha256": digest,
        }

    def freeze(self) -> None:
        """在子进程结束后把转录冻结为当前用户只读证据。"""

        if self._frozen:
            return
        try:
            if self.path.exists():
                self.path.chmod(0o400)
            self._frozen = True
        except OSError as error:
            raise ChatPiSessionError("无法冻结Chat托管pi Session") from error


def prepare_chat_pi_session(
    *,
    directory: Path,
    working_directory: str,
    tool_execution_id: str,
    product_session_id: str | None,
    product_run_id: str | None,
) -> ChatPiSession:
    """排他创建一个最小合法 v3 JSONL 文件，确保启动失败也留下执行关联。

    使用显式文件而不是仅传 ``--session-id``，因为 pi 会把普通新 Session 的首次
    落盘延迟到 Assistant 消息；若在 Provider 审批前终止，会缺少用户 Prompt 证据。
    """

    session_id = session_id_for_tool_execution(tool_execution_id)
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    file_timestamp = timestamp.replace(":", "-").replace(".", "-")
    path = directory.expanduser().resolve() / f"{file_timestamp}_{session_id}.jsonl"
    header = {
        "type": "session",
        "version": PI_SESSION_FORMAT_VERSION,
        "id": session_id,
        "timestamp": timestamp,
        "cwd": working_directory,
    }
    try:
        directory_path = path.parent
        directory_path.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory_path.chmod(0o700)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(header, ensure_ascii=False, separators=(",", ":")))
            stream.write("\n")
    except OSError as error:
        raise ChatPiSessionError("无法创建Chat托管pi Session") from error
    return ChatPiSession(
        id=session_id,
        path=path,
        product_session_id=product_session_id,
        product_run_id=product_run_id,
        tool_execution_id=tool_execution_id,
        name=session_display_name(
            product_session_id=product_session_id,
            product_run_id=product_run_id,
            tool_execution_id=tool_execution_id,
        ),
    )


def pending_pi_session_view(
    *,
    tool_execution_id: str,
    product_session_id: str | None,
    product_run_id: str | None,
) -> dict[str, Any]:
    """在子进程启动前写入账本的确定性映射；不宣称文件已经创建。"""

    return {
        "id": session_id_for_tool_execution(tool_execution_id),
        "source": "chat",
        "managed_by": "chat",
        "product_session_id": product_session_id,
        "product_run_id": product_run_id,
        "tool_execution_id": tool_execution_id,
        "storage": "dedicated_pi_session_directory",
        "auto_resume": False,
        "fork_enabled": False,
        "read_only": False,
        "state": "pending_creation",
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(64 * 1024):
            digest.update(chunk)
    return digest.hexdigest()

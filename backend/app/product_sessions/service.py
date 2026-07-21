"""Application service for authoritative Product Session and Run facts."""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select, update
from .database import (
    InteractionRecord,
    MessageRecord,
    ProductDatabase,
    RunAttemptRecord,
    RunProtocolRecord,
    RunRecord,
    SessionRecord,
    TraceRecord,
    utc_now,
)


DEFAULT_SCOPE_ID = "local-user"
ACTIVE_RUN_STATUSES = {"accepted", "running", "waiting_approval", "committing"}


class ProductSessionError(ValueError):
    code = "SESSION_INVALID"


class ProductSessionNotFound(ProductSessionError):
    code = "SESSION_NOT_FOUND"


class ProductSessionConflict(ProductSessionError):
    code = "SESSION_CONFLICT"


class IdempotencyConflict(ProductSessionConflict):
    code = "IDEMPOTENCY_CONFLICT"


class SessionBusy(ProductSessionConflict):
    code = "SESSION_BUSY"


class SessionHistoryConflict(ProductSessionConflict):
    code = "SESSION_HISTORY_CONFLICT"


@dataclass(frozen=True, slots=True)
class AcceptedRun:
    session_id: str
    product_run_id: str
    interaction_id: str
    user_message_id: str
    agui_run_id: str
    provider_id: str | None
    model: str | None
    is_resume: bool


def _uuid() -> str:
    return str(uuid.uuid4())


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        value = item.get("text") if isinstance(item.get("text"), str) else item.get("content")
        if isinstance(value, str) and item.get("type") in {"text", "input_text", "output_text"}:
            parts.append(value)
    return "\n".join(parts)


def _incoming_visible_messages(values: list[dict[str, Any]]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for value in values:
        role = value.get("role")
        if role not in {"user", "assistant"}:
            continue
        text = _message_text(value.get("content"))
        if not text:
            continue
        messages.append(
            {
                "id": str(value.get("id") or value.get("message_id") or _uuid()),
                "role": str(role),
                "text": text,
            }
        )
    return messages


def _session_view(value: SessionRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "thread_id": value.id,
        "scope_id": value.scope_id,
        "channel": value.channel,
        "title": value.title,
        "status": value.status,
        "revision": value.revision,
        "active_run_id": value.active_run_id,
        "model_provider_id": value.model_provider_id,
        "model": value.model,
        "created_at": _iso(value.created_at),
        "updated_at": _iso(value.updated_at),
        "archived_at": _iso(value.archived_at),
    }


def _message_view(value: MessageRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "agui_message_id": value.agui_message_id,
        "session_id": value.session_id,
        "interaction_id": value.interaction_id,
        "run_id": value.run_id,
        "parent_message_id": value.parent_message_id,
        "role": value.role,
        "content": value.content,
        "status": value.status,
        "context_eligible": value.context_eligible,
        "ordinal": value.ordinal,
        "revision": value.revision,
        "created_at": _iso(value.created_at),
    }


def _attempt_view(value: RunAttemptRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "attempt_number": value.attempt_number,
        "runtime_kind": value.runtime_kind,
        "status": value.status,
        "failure_code": value.failure_code,
        "failure_message": value.failure_message,
        "started_at": _iso(value.started_at),
        "finished_at": _iso(value.finished_at),
    }


def _run_view(value: RunRecord, attempts: list[RunAttemptRecord] | None = None) -> dict[str, Any]:
    return {
        "id": value.id,
        "session_id": value.session_id,
        "interaction_id": value.interaction_id,
        "agui_run_id": value.initial_agui_run_id,
        "status": value.status,
        "current_user_message_id": value.current_user_message_id,
        "assistant_message_id": value.assistant_message_id,
        "model_provider_id": value.model_provider_id,
        "model": value.model,
        "draft_id": value.draft_id,
        "approval_id": value.approval_id,
        "failure_code": value.failure_code,
        "failure_message": value.failure_message,
        "started_at": _iso(value.started_at),
        "finished_at": _iso(value.finished_at),
        "attempts": [_attempt_view(attempt) for attempt in (attempts or [])],
    }


class ProductSessionService:
    """Apply Session/Interaction/Message/Run invariants in short transactions."""

    def __init__(self, database: ProductDatabase, *, scope_id: str = DEFAULT_SCOPE_ID) -> None:
        self.database = database
        self.scope_id = scope_id

    async def initialize(self) -> None:
        await self.database.initialize()
        await self.reconcile_orphaned_runs()

    async def create_session(
        self,
        *,
        title: str = "新会话",
        provider_id: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        record = SessionRecord(
            id=_uuid(),
            scope_id=self.scope_id,
            channel="web",
            title=title.strip()[:160] or "新会话",
            model_provider_id=provider_id,
            model=model,
        )
        async with self.database.sessions.begin() as transaction:
            transaction.add(record)
        return _session_view(record)

    async def list_sessions(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            query = select(SessionRecord).where(SessionRecord.scope_id == self.scope_id)
            if not include_archived:
                query = query.where(SessionRecord.status == "active")
            values = list((await transaction.scalars(query.order_by(SessionRecord.updated_at.desc()))).all())
        return [_session_view(value) for value in values]

    async def get_session(self, session_id: str) -> dict[str, Any]:
        async with self.database.sessions() as transaction:
            value = await self._session(transaction, session_id)
            return _session_view(value)

    async def update_session(
        self,
        session_id: str,
        *,
        title: str | None = None,
        archived: bool | None = None,
        provider_id: str | None = None,
        model: str | None = None,
        update_model: bool = False,
    ) -> dict[str, Any]:
        async with self.database.sessions.begin() as transaction:
            value = await self._session(transaction, session_id)
            if value.active_run_id is not None and archived:
                raise SessionBusy("活动Run结束前不能归档会话")
            if title is not None:
                value.title = title.strip()[:160] or "新会话"
            if archived is not None:
                value.status = "archived" if archived else "active"
                value.archived_at = utc_now() if archived else None
            if update_model:
                value.model_provider_id = provider_id
                value.model = model
            value.revision += 1
            value.updated_at = utc_now()
        return _session_view(value)

    async def list_messages(self, session_id: str) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            await self._session(transaction, session_id)
            values = list(
                (
                    await transaction.scalars(
                        select(MessageRecord)
                        .where(
                            MessageRecord.session_id == session_id,
                            MessageRecord.status == "committed",
                        )
                        .order_by(MessageRecord.ordinal)
                    )
                ).all()
            )
        return [_message_view(value) for value in values]

    async def list_runs(self, session_id: str) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            await self._session(transaction, session_id)
            values = list(
                (
                    await transaction.scalars(
                        select(RunRecord)
                        .where(RunRecord.session_id == session_id)
                        .order_by(RunRecord.started_at.desc())
                    )
                ).all()
            )
            run_ids = [value.id for value in values]
            attempts = (
                list(
                    (
                        await transaction.scalars(
                            select(RunAttemptRecord)
                            .where(RunAttemptRecord.run_id.in_(run_ids))
                            .order_by(RunAttemptRecord.run_id, RunAttemptRecord.attempt_number)
                        )
                    ).all()
                )
                if run_ids
                else []
            )
        attempts_by_run: dict[str, list[RunAttemptRecord]] = {}
        for attempt in attempts:
            attempts_by_run.setdefault(attempt.run_id, []).append(attempt)
        return [_run_view(value, attempts_by_run.get(value.id)) for value in values]

    async def prepare_agui_run(self, input_data: dict[str, Any]) -> AcceptedRun:
        session_id = str(input_data.get("thread_id") or input_data.get("threadId") or "")
        agui_run_id = str(input_data.get("run_id") or input_data.get("runId") or "")
        if not session_id or not agui_run_id:
            raise ProductSessionError("AG-UI请求必须包含threadId和runId")
        if input_data.get("resume") is not None:
            accepted = await self._resume_run(session_id, agui_run_id)
            return accepted

        raw_messages = input_data.get("messages") or []
        if not isinstance(raw_messages, list):
            raise SessionHistoryConflict("AG-UI messages必须是数组")
        incoming = _incoming_visible_messages(raw_messages)
        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.status != "active":
                raise ProductSessionConflict("已归档会话不能启动新Run")

            existing_protocol = await transaction.scalar(
                select(RunProtocolRecord).where(
                    RunProtocolRecord.session_id == session_id,
                    RunProtocolRecord.agui_run_id == agui_run_id,
                )
            )
            if existing_protocol is not None:
                run = await transaction.get(RunRecord, existing_protocol.product_run_id)
                if run is None:
                    raise ProductSessionConflict("AG-UI Run映射损坏")
                if run.status not in ACTIVE_RUN_STATUSES:
                    raise IdempotencyConflict("该AG-UI runId已经结束，不能再次触发执行")
                persisted = list(
                    (
                        await transaction.scalars(
                            select(MessageRecord)
                            .where(
                                MessageRecord.session_id == session_id,
                                MessageRecord.status == "committed",
                            )
                            .order_by(MessageRecord.ordinal)
                        )
                    ).all()
                )
                if len(incoming) != len(persisted) or any(
                    client_message["id"] != server_message.agui_message_id
                    or client_message["role"] != server_message.role
                    or _hash(client_message["text"]) != server_message.content_hash
                    for client_message, server_message in zip(incoming, persisted, strict=True)
                ):
                    raise IdempotencyConflict("相同AG-UI runId携带了不同请求内容")
                return AcceptedRun(
                    session_id=session_id,
                    product_run_id=run.id,
                    interaction_id=run.interaction_id,
                    user_message_id=run.current_user_message_id,
                    agui_run_id=agui_run_id,
                    provider_id=run.model_provider_id,
                    model=run.model,
                    is_resume=False,
                )
            if session.active_run_id is not None:
                raise SessionBusy("该会话已有活动Run，请先完成或放弃当前操作")

            persisted = list(
                (
                    await transaction.scalars(
                        select(MessageRecord)
                        .where(
                            MessageRecord.session_id == session_id,
                            MessageRecord.status == "committed",
                        )
                        .order_by(MessageRecord.ordinal)
                    )
                ).all()
            )
            if len(incoming) != len(persisted) + 1:
                raise SessionHistoryConflict("客户端必须携带服务端历史前缀和恰好1条新User消息")
            for client_message, server_message in zip(incoming[:-1], persisted, strict=True):
                if (
                    client_message["id"] != server_message.agui_message_id
                    or client_message["role"] != server_message.role
                    or _hash(client_message["text"]) != server_message.content_hash
                ):
                    raise SessionHistoryConflict("客户端历史与Product Store不一致，请重新加载会话")
            current = incoming[-1]
            if current["role"] != "user" or not current["text"].strip():
                raise SessionHistoryConflict("新消息必须是非空User消息")
            if any(value.agui_message_id == current["id"] for value in persisted):
                raise SessionHistoryConflict("新消息ID不能复用已有Product Message映射")

            interaction_id = _uuid()
            product_run_id = _uuid()
            user_message_id = _uuid()
            next_revision = session.revision + 1
            request_hash = _hash(
                {
                    "session_id": session_id,
                    "revision": session.revision,
                    "agui_run_id": agui_run_id,
                    "message_id": current["id"],
                    "content": current["text"],
                    "provider_id": session.model_provider_id,
                    "model": session.model,
                }
            )
            claimed = await transaction.execute(
                update(SessionRecord)
                .where(
                    SessionRecord.id == session_id,
                    SessionRecord.scope_id == self.scope_id,
                    SessionRecord.status == "active",
                    SessionRecord.active_run_id.is_(None),
                    SessionRecord.revision == session.revision,
                )
                .values(
                    active_run_id=product_run_id,
                    revision=next_revision,
                    updated_at=utc_now(),
                    title=(
                        current["text"].strip().replace("\n", " ")[:40]
                        if not persisted and session.title == "新会话"
                        else session.title
                    ),
                )
            )
            if claimed.rowcount != 1:
                raise SessionBusy("会话状态已变化，请重新加载后再发送")

            transaction.add(
                InteractionRecord(
                    id=interaction_id,
                    session_id=session_id,
                    user_message_id=user_message_id,
                    status="accepted",
                )
            )
            await transaction.flush()
            transaction.add(
                RunRecord(
                    id=product_run_id,
                    session_id=session_id,
                    interaction_id=interaction_id,
                    initial_agui_run_id=agui_run_id,
                    request_hash=request_hash,
                    status="accepted",
                    current_user_message_id=user_message_id,
                    model_provider_id=session.model_provider_id,
                    model=session.model,
                )
            )
            await transaction.flush()
            transaction.add(
                RunAttemptRecord(
                    id=_uuid(),
                    run_id=product_run_id,
                    attempt_number=1,
                    runtime_kind="in_process",
                    status="accepted",
                )
            )
            transaction.add(
                MessageRecord(
                    id=user_message_id,
                    session_id=session_id,
                    interaction_id=interaction_id,
                    run_id=product_run_id,
                    agui_message_id=current["id"],
                    role="user",
                    content=current["text"],
                    content_hash=_hash(current["text"]),
                    ordinal=len(persisted) + 1,
                    revision=next_revision,
                )
            )
            transaction.add(
                RunProtocolRecord(
                    id=_uuid(),
                    session_id=session_id,
                    product_run_id=product_run_id,
                    agui_run_id=agui_run_id,
                    kind="initial",
                )
            )
            transaction.add(
                TraceRecord(
                    id=_uuid(),
                    session_id=session_id,
                    run_id=product_run_id,
                    sequence=1,
                    event_type="run.accepted",
                    payload={"agui_run_id": agui_run_id, "request_hash": request_hash},
                )
            )

        await self.replace_input_with_product_history(input_data, session_id)
        return AcceptedRun(
            session_id=session_id,
            product_run_id=product_run_id,
            interaction_id=interaction_id,
            user_message_id=user_message_id,
            agui_run_id=agui_run_id,
            provider_id=session.model_provider_id,
            model=session.model,
            is_resume=False,
        )

    async def _resume_run(self, session_id: str, agui_run_id: str) -> AcceptedRun:
        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                raise ProductSessionConflict("该会话没有可恢复的活动Run")
            run = await transaction.get(RunRecord, session.active_run_id)
            if run is None or run.status not in ACTIVE_RUN_STATUSES:
                raise ProductSessionConflict("活动Run状态不允许恢复")
            existing = await transaction.scalar(
                select(RunProtocolRecord).where(
                    RunProtocolRecord.session_id == session_id,
                    RunProtocolRecord.agui_run_id == agui_run_id,
                )
            )
            if existing is not None and existing.product_run_id != run.id:
                raise ProductSessionConflict("AG-UI runId已绑定其他Product Run")
            if existing is None:
                transaction.add(
                    RunProtocolRecord(
                        id=_uuid(),
                        session_id=session_id,
                        product_run_id=run.id,
                        agui_run_id=agui_run_id,
                        kind="resume",
                    )
                )
            return AcceptedRun(
                session_id=session_id,
                product_run_id=run.id,
                interaction_id=run.interaction_id,
                user_message_id=run.current_user_message_id,
                agui_run_id=agui_run_id,
                provider_id=run.model_provider_id,
                model=run.model,
                is_resume=True,
            )

    async def replace_input_with_product_history(
        self, input_data: dict[str, Any], session_id: str
    ) -> None:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(MessageRecord)
                        .where(
                            MessageRecord.session_id == session_id,
                            MessageRecord.status == "committed",
                            MessageRecord.context_eligible.is_(True),
                        )
                        .order_by(MessageRecord.ordinal)
                    )
                ).all()
            )
        input_data["messages"] = [
            {"id": value.agui_message_id, "role": value.role, "content": value.content}
            for value in values
        ]

    async def mark_waiting_approval(
        self,
        session_id: str,
        *,
        draft_id: str | None = None,
        approval_id: str | None = None,
    ) -> None:
        await self._transition_active(
            session_id,
            allowed=ACTIVE_RUN_STATUSES,
            status="waiting_approval",
            draft_id=draft_id,
            approval_id=approval_id,
        )

    async def mark_running(self, session_id: str) -> None:
        await self._transition_active(
            session_id,
            allowed={"accepted", "waiting_approval", "running"},
            status="running",
        )

    async def abandon_active_run(self, session_id: str) -> None:
        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return
            run = await transaction.get(RunRecord, session.active_run_id)
            if run is None or run.status not in ACTIVE_RUN_STATUSES:
                return
            run.status = "abandoned"
            run.finished_at = utc_now()
            await self._finish_attempt(transaction, run, status="abandoned")
            interaction = await transaction.get(InteractionRecord, run.interaction_id)
            if interaction is not None:
                interaction.status = "abandoned"
                interaction.updated_at = utc_now()
            message = await transaction.get(MessageRecord, run.current_user_message_id)
            if message is not None:
                message.status = "withdrawn"
                message.context_eligible = False
            session.active_run_id = None
            session.revision += 1
            session.updated_at = utc_now()
            await self._trace(transaction, run, "run.abandoned", {})

    async def fail_active_run(
        self,
        session_id: str,
        *,
        status: str = "failed",
        error_code: str | None = None,
        message: str | None = None,
    ) -> None:
        if status not in {"failed", "outcome_unknown", "cancelled", "interrupted"}:
            raise ValueError(f"Unsupported terminal status: {status}")
        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return
            run = await transaction.get(RunRecord, session.active_run_id)
            if run is None or run.status not in ACTIVE_RUN_STATUSES:
                return
            run.status = status
            run.failure_code = error_code
            run.failure_message = message
            run.finished_at = utc_now()
            await self._finish_attempt(
                transaction,
                run,
                status=status,
                failure_code=error_code,
                failure_message=message,
            )
            interaction = await transaction.get(InteractionRecord, run.interaction_id)
            if interaction is not None:
                interaction.status = status
                interaction.updated_at = utc_now()
            session.active_run_id = None
            session.updated_at = utc_now()
            await self._trace(
                transaction,
                run,
                f"run.{status}",
                {"error_code": error_code, "message": message},
            )

    async def complete_active_run(
        self,
        session_id: str,
        *,
        assistant_text: str,
        agui_message_id: str | None,
    ) -> dict[str, Any] | None:
        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return None
            run = await transaction.get(RunRecord, session.active_run_id)
            if run is None or run.status not in ACTIVE_RUN_STATUSES:
                return None
            run.status = "committing"
            text = assistant_text.strip() or "模型调用已完成，但没有返回可显示的文本。"
            current_ordinal = await transaction.scalar(
                select(func.max(MessageRecord.ordinal)).where(MessageRecord.session_id == session_id)
            )
            message = MessageRecord(
                id=_uuid(),
                session_id=session_id,
                interaction_id=run.interaction_id,
                run_id=run.id,
                agui_message_id=agui_message_id or f"assistant-{_uuid()}",
                role="assistant",
                content=text,
                content_hash=_hash(text),
                ordinal=int(current_ordinal or 0) + 1,
                revision=session.revision + 1,
            )
            transaction.add(message)
            run.assistant_message_id = message.id
            run.status = "succeeded"
            run.finished_at = utc_now()
            await self._finish_attempt(transaction, run, status="succeeded")
            interaction = await transaction.get(InteractionRecord, run.interaction_id)
            if interaction is not None:
                interaction.status = "succeeded"
                interaction.updated_at = utc_now()
            session.active_run_id = None
            session.revision += 1
            session.updated_at = utc_now()
            await self._trace(transaction, run, "run.succeeded", {"assistant_message_id": message.id})
        return _message_view(message)

    async def active_run(self, session_id: str) -> dict[str, Any] | None:
        async with self.database.sessions() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return None
            run = await transaction.get(RunRecord, session.active_run_id)
            return _run_view(run) if run is not None else None

    async def reconcile_orphaned_runs(self) -> int:
        async with self.database.sessions.begin() as transaction:
            runs = list(
                (
                    await transaction.scalars(
                        select(RunRecord).where(RunRecord.status.in_(ACTIVE_RUN_STATUSES))
                    )
                ).all()
            )
            for run in runs:
                run.status = "interrupted"
                run.failure_code = "process_restarted"
                run.failure_message = "后端进程重启，无法证明此前活动Run已经安全完成。"
                run.finished_at = utc_now()
                await self._finish_attempt(
                    transaction,
                    run,
                    status="interrupted",
                    failure_code="process_restarted",
                    failure_message="后端进程重启，无法证明此前活动Run已经安全完成。",
                )
                interaction = await transaction.get(InteractionRecord, run.interaction_id)
                if interaction is not None:
                    interaction.status = "interrupted"
                    interaction.updated_at = utc_now()
                session = await transaction.get(SessionRecord, run.session_id)
                if session is not None and session.active_run_id == run.id:
                    session.active_run_id = None
                    session.updated_at = utc_now()
                await self._trace(transaction, run, "run.interrupted", {"reason": "process_restarted"})
        return len(runs)

    async def _transition_active(
        self,
        session_id: str,
        *,
        allowed: set[str],
        status: str,
        draft_id: str | None = None,
        approval_id: str | None = None,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return
            run = await transaction.get(RunRecord, session.active_run_id)
            if run is None or run.status not in allowed:
                return
            run.status = status
            attempt = await self._current_attempt(transaction, run.id)
            if attempt is not None:
                attempt.status = status
            if draft_id is not None:
                run.draft_id = draft_id
            if approval_id is not None:
                run.approval_id = approval_id
            interaction = await transaction.get(InteractionRecord, run.interaction_id)
            if interaction is not None:
                interaction.status = status
                interaction.updated_at = utc_now()
            session.updated_at = utc_now()
            await self._trace(transaction, run, f"run.{status}", {})

    async def _session(self, transaction: Any, session_id: str) -> SessionRecord:
        value = await transaction.scalar(
            select(SessionRecord).where(
                SessionRecord.id == session_id,
                SessionRecord.scope_id == self.scope_id,
            )
        )
        if value is None:
            raise ProductSessionNotFound("Product Session不存在")
        return value

    async def _current_attempt(
        self, transaction: Any, run_id: str
    ) -> RunAttemptRecord | None:
        return await transaction.scalar(
            select(RunAttemptRecord)
            .where(RunAttemptRecord.run_id == run_id)
            .order_by(RunAttemptRecord.attempt_number.desc())
            .limit(1)
        )

    async def _finish_attempt(
        self,
        transaction: Any,
        run: RunRecord,
        *,
        status: str,
        failure_code: str | None = None,
        failure_message: str | None = None,
    ) -> None:
        attempt = await self._current_attempt(transaction, run.id)
        if attempt is None:
            return
        attempt.status = status
        attempt.failure_code = failure_code
        attempt.failure_message = failure_message
        attempt.finished_at = utc_now()

    async def _trace(
        self, transaction: Any, run: RunRecord, event_type: str, payload: dict[str, Any]
    ) -> None:
        sequence = await transaction.scalar(
            select(func.max(TraceRecord.sequence)).where(TraceRecord.run_id == run.id)
        )
        transaction.add(
            TraceRecord(
                id=_uuid(),
                session_id=run.session_id,
                run_id=run.id,
                sequence=int(sequence or 0) + 1,
                event_type=event_type,
                payload=payload,
            )
        )

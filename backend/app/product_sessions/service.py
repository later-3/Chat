"""持续协作外层生命周期的权威Product Session/Message/Run应用服务。

AG-UI入口先用``prepare_agui_run``创建Interaction、Product Run、Run Attempt和User
Message；Workflow运行期间用``record_trace``追加单调Sequence事件；成功、失败、取消、
放弃或重启收敛时，由本服务更新权威终态。每个终态事务同时物化机器版与人读版双Trace，
报告是可重建投影，``trace_events``及各领域表仍是事实源。
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterable, Mapping
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
    RunTraceReportRecord,
    SessionRecord,
    ToolExecutionRecord,
    TraceRecord,
    affected_row_count,
    utc_now,
)
from .trace_reports import TERMINAL_RUN_STATUSES, build_run_trace_reports, content_hash

DEFAULT_SCOPE_ID = "local-user"
ACTIVE_RUN_STATUSES = {"accepted", "running", "waiting_approval", "committing"}


class ProductSessionError(ValueError):
    """Product Session应用层错误基类；``code``是返回前端的稳定错误码。"""

    code = "SESSION_INVALID"


class ProductSessionNotFound(ProductSessionError):
    """目标Product Session不存在（或不在当前可信Scope内）。"""

    code = "SESSION_NOT_FOUND"


class ProductSessionConflict(ProductSessionError):
    """会话状态与请求冲突的基类（归档、竞态、映射损坏等）。"""

    code = "SESSION_CONFLICT"


class IdempotencyConflict(ProductSessionConflict):
    """相同AG-UI runId携带了不同请求内容：拒绝而不是覆盖，保证重连幂等。"""

    code = "IDEMPOTENCY_CONFLICT"


class SessionBusy(ProductSessionConflict):
    """该Product Session已有活动Run；一个会话同一时刻只允许1个活动Run。"""

    code = "SESSION_BUSY"


class SessionHistoryConflict(ProductSessionConflict):
    """客户端消息与服务端权威历史不一致：防止AG-UI消息全集与Product历史双写。"""

    code = "SESSION_HISTORY_CONFLICT"


@dataclass(frozen=True, slots=True)
class AcceptedRun:
    """接纳门通过后的返回值：Product/AG-UI两侧ID与运行配置，供Worker领取执行。"""

    session_id: str
    product_run_id: str
    interaction_id: str
    user_message_id: str
    agui_run_id: str
    provider_id: str | None
    model: str | None
    is_resume: bool


def _uuid() -> str:
    """生成产品对象ID；ID本身不构成授权，只标识对象。"""

    return str(uuid.uuid4())


def _canonical(value: Any) -> str:
    """把值序列化为规范化JSON文本（键排序、紧凑分隔），供内容Hash使用。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: Any) -> str:
    """对值生成规范化SHA-256；消息内容与请求体的比对、幂等判定都依赖它。"""
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _iso(value: datetime | None) -> str | None:
    """时间转ISO字符串；None安全，供REST视图投影使用。"""
    return value.isoformat() if value is not None else None


def _message_text(content: Any) -> str:
    """从AG-UI消息content提取纯文本；片段数组拼接text，非文本返回空串。"""
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
    """从AG-UI请求中筛出User/Assistant可见消息；过滤request_info等审批协议消息。"""

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


def _retry_control(input_data: dict[str, Any]) -> tuple[str, str] | None:
    """解析Retry/Restart控制字段；返回(语义, 血缘Run ID)或None（普通新Run）。"""

    forwarded = input_data.get("forwarded_props") or input_data.get("forwardedProps")
    if not isinstance(forwarded, dict):
        return None
    control = forwarded.get("session_control") or forwarded.get("sessionControl")
    if control is None:
        return None
    if not isinstance(control, dict):
        raise ProductSessionConflict("Session控制参数格式无效")
    kind = str(control.get("kind") or "")
    source_run_id = str(control.get("source_run_id") or control.get("sourceRunId") or "")
    if kind not in {"retry", "restart"} or not source_run_id:
        raise ProductSessionConflict("Session重试必须指定retry/restart及来源Run")
    return kind, source_run_id


def _session_view(value: SessionRecord) -> dict[str, Any]:
    """Product Session的REST投影：含短定位码与标题来源，不含内部敏感字段。"""

    return {
        "id": value.id,
        "thread_id": value.id,
        "scope_id": value.scope_id,
        "channel": value.channel,
        "title": value.title,
        "title_origin": value.title_origin,
        "title_source_message_id": value.title_source_message_id,
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
    """Message的REST投影：角色、内容、状态与关联ID；withdrawn消息由查询层过滤。"""

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
    """Run Attempt的REST投影：第几次尝试、状态、Worker所有权与恢复血缘。"""

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


def _run_view(
    value: RunRecord,
    attempts: list[RunAttemptRecord] | None = None,
    user_message: MessageRecord | None = None,
) -> dict[str, Any]:
    """Product Run的REST投影：状态、模型配置、Attempt摘要与来源User Message片段。"""

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
        "retry_of_run_id": value.retry_of_run_id,
        "retry_mode": value.retry_mode,
        "input_text": _message_text(user_message.content) if user_message is not None else None,
        "failure_code": value.failure_code,
        "failure_message": value.failure_message,
        "started_at": _iso(value.started_at),
        "finished_at": _iso(value.finished_at),
        "attempts": [_attempt_view(attempt) for attempt in (attempts or [])],
    }


def _trace_view(value: TraceRecord) -> dict[str, Any]:
    """Trace的REST投影：事件类型、关联ID与公开载荷；不输出隐藏推理或密钥。"""

    return {
        "id": value.id,
        "session_id": value.session_id,
        "run_id": value.run_id,
        "sequence": value.sequence,
        "event_type": value.event_type,
        "payload": value.payload,
        "created_at": _iso(value.created_at),
    }


def _trace_report_view(value: RunTraceReportRecord) -> dict[str, Any]:
    """把双Trace报告行投影为稳定REST结构。"""

    return {
        "id": value.id,
        "session_id": value.session_id,
        "run_id": value.run_id,
        "report_kind": value.report_kind,
        "schema_version": value.schema_version,
        "workflow_definition_id": value.workflow_definition_id,
        "workflow_version": value.workflow_version,
        "source_first_sequence": value.source_first_sequence,
        "source_last_sequence": value.source_last_sequence,
        "source_event_count": value.source_event_count,
        "content_hash": value.content_hash,
        "content": value.content_json,
        "text": value.content_text,
        "created_at": _iso(value.created_at),
        "updated_at": _iso(value.updated_at),
    }


class ProductSessionService:
    """在短事务内执行Session/Interaction/Message/Run不变量和终态报告物化。"""

    def __init__(self, database: ProductDatabase, *, scope_id: str = DEFAULT_SCOPE_ID) -> None:
        """绑定Product Store与当前Scope；正式Identity落地前固定为本地单Scope。"""

        self.database = database
        self.scope_id = scope_id
        # Definition只用于解释同版本Trace，不参与Workflow执行或产品状态转换。
        # 由composition在运行前注入，避免Product Session反向依赖Workflow包。
        self._trace_workflow_definitions: dict[str, dict[str, Any]] = {}

    def configure_trace_workflows(self, definitions: Iterable[Any]) -> None:
        """注册可用于人读报告的Workflow Definition快照。

        只有Trace中的``workflow_id + version``与这里完全一致时，报告才会使用
        节点说明和固定边解释路径；版本不匹配时宁可标记历史信息缺失，也不拿
        当前代码倒推旧Run。
        """

        configured: dict[str, dict[str, Any]] = {}
        for definition in definitions:
            if isinstance(definition, Mapping):
                view = dict(definition)
            else:
                projector = getattr(definition, "view", None)
                if not callable(projector):
                    continue
                projected = projector()
                if not isinstance(projected, Mapping):
                    continue
                view = dict(projected)
            workflow_id = str(view.get("id") or "").strip()
            if workflow_id:
                configured[workflow_id] = view
        self._trace_workflow_definitions = configured

    async def initialize(self) -> None:
        """启动初始化：建库、收敛上次进程遗留的活动Run、回填终态双Trace报告。"""

        await self.database.initialize()
        await self.reconcile_orphaned_runs()
        await self.backfill_terminal_trace_reports()

    async def create_session(
        self,
        *,
        title: str = "新会话",
        provider_id: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        """创建Product Session：标题来源区分default/manual；会话模型只是默认值，不覆盖Workflow节点Profile。"""

        normalized_title = title.strip()[:160] or "新会话"
        record = SessionRecord(
            id=_uuid(),
            scope_id=self.scope_id,
            channel="web",
            title=normalized_title,
            title_origin="default" if normalized_title == "新会话" else "manual",
            model_provider_id=provider_id,
            model=model,
        )
        async with self.database.sessions.begin() as transaction:
            transaction.add(record)
        return _session_view(record)

    async def list_sessions(self, *, include_archived: bool = False) -> list[dict[str, Any]]:
        """列出当前Scope的会话；归档默认隐藏，归档不等于删除。"""

        async with self.database.sessions() as transaction:
            query = select(SessionRecord).where(SessionRecord.scope_id == self.scope_id)
            if not include_archived:
                query = query.where(SessionRecord.status == "active")
            values = list((await transaction.scalars(query.order_by(SessionRecord.updated_at.desc()))).all())
        return [_session_view(value) for value in values]

    async def get_session(self, session_id: str) -> dict[str, Any]:
        """读取单个会话投影；越Scope访问与不存在一样返回NotFound，不泄露存在性。"""

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
        """更新标题/模型默认或执行归档：手工标题不被自动标题回滚；归档拒绝新Run。"""
        async with self.database.sessions.begin() as transaction:
            value = await self._session(transaction, session_id)
            if value.active_run_id is not None and archived:
                raise SessionBusy("活动Run结束前不能归档会话")
            if title is not None:
                value.title = title.strip()[:160] or "新会话"
                value.title_origin = "manual"
                value.title_source_message_id = None
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
        """按ordinal返回committed可见历史；withdrawn与审批协议消息不进入该投影。"""

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
        """列出会话的Product Run及Attempt摘要；运行事实的唯一产品投影。"""

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
            user_message_ids = [value.current_user_message_id for value in values]
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
            user_messages = (
                list(
                    (
                        await transaction.scalars(
                            select(MessageRecord).where(MessageRecord.id.in_(user_message_ids))
                        )
                    ).all()
                )
                if user_message_ids
                else []
            )
        attempts_by_run: dict[str, list[RunAttemptRecord]] = {}
        for attempt in attempts:
            attempts_by_run.setdefault(attempt.run_id, []).append(attempt)
        messages_by_id = {value.id: value for value in user_messages}
        return [
            _run_view(
                value,
                attempts_by_run.get(value.id),
                messages_by_id.get(value.current_user_message_id),
            )
            for value in values
        ]

    async def list_trace(self, session_id: str, run_id: str) -> list[dict[str, Any]]:
        """按sequence返回一个Run的Product Trace事件；节点详情的数据源。"""

        async with self.database.sessions() as transaction:
            await self._session(transaction, session_id)
            run = await transaction.scalar(
                select(RunRecord).where(
                    RunRecord.id == run_id,
                    RunRecord.session_id == session_id,
                )
            )
            if run is None:
                raise ProductSessionNotFound("Product Run不存在")
            values = list(
                (
                    await transaction.scalars(
                        select(TraceRecord)
                        .where(
                            TraceRecord.session_id == session_id,
                            TraceRecord.run_id == run_id,
                        )
                        .order_by(TraceRecord.sequence)
                    )
                ).all()
            )
        return [_trace_view(value) for value in values]

    async def list_trace_reports(self, session_id: str, run_id: str) -> list[dict[str, Any]]:
        """读取一轮终态Run的机器版和人读版Trace报告。

        正常路径在Run终态事务内已经物化。这里保留一次确定性自修复：迁移前的旧Run、
        或极端情况下缺失/落后的报告，会先用现有Product Trace重建再返回。活动Run尚未
        “走完”，因此明确返回空列表，前端继续读取实时Trace即可。
        """

        async with self.database.sessions() as transaction:
            await self._session(transaction, session_id)
            run = await transaction.scalar(
                select(RunRecord).where(
                    RunRecord.id == run_id,
                    RunRecord.session_id == session_id,
                )
            )
            if run is None:
                raise ProductSessionNotFound("Product Run不存在")
            if run.status not in TERMINAL_RUN_STATUSES:
                return []
            reports = list(
                (
                    await transaction.scalars(
                        select(RunTraceReportRecord)
                        .where(RunTraceReportRecord.run_id == run_id)
                        .order_by(RunTraceReportRecord.report_kind)
                    )
                ).all()
            )
            latest_trace_sequence = int(
                await transaction.scalar(
                    select(func.max(TraceRecord.sequence)).where(TraceRecord.run_id == run_id)
                )
                or 0
            )
            definition_upgrade_available = any(
                isinstance(value.content_json, Mapping)
                and isinstance(value.content_json.get("workflow"), Mapping)
                and value.content_json["workflow"].get("definition_match") is not True
                and (
                    registered := self._trace_workflow_definitions.get(
                        str(value.content_json["workflow"].get("id") or "")
                    )
                )
                is not None
                and registered.get("version") == value.content_json["workflow"].get("version")
                for value in reports
            )
            needs_rebuild = (
                len(reports) != 2
                or any(value.source_last_sequence != latest_trace_sequence for value in reports)
                or definition_upgrade_available
            )
        if needs_rebuild:
            async with self.database.sessions.begin() as transaction:
                run = await transaction.scalar(
                    select(RunRecord).where(
                        RunRecord.id == run_id,
                        RunRecord.session_id == session_id,
                    )
                )
                if run is None:
                    raise ProductSessionNotFound("Product Run不存在")
                await self._materialize_trace_reports(transaction, run)
            async with self.database.sessions() as transaction:
                reports = list(
                    (
                        await transaction.scalars(
                            select(RunTraceReportRecord)
                            .where(RunTraceReportRecord.run_id == run_id)
                            .order_by(RunTraceReportRecord.report_kind)
                        )
                    ).all()
                )
        return [_trace_report_view(value) for value in reports]

    async def backfill_terminal_trace_reports(self) -> int:
        """为迁移前的终态Run补齐双报告，不改变任何权威Run/Trace事实。"""

        async with self.database.sessions() as transaction:
            terminal_run_ids = list(
                (
                    await transaction.scalars(
                        select(RunRecord.id).where(RunRecord.status.in_(TERMINAL_RUN_STATUSES))
                    )
                ).all()
            )
            report_count_rows = (
                (
                    await transaction.execute(
                        select(RunTraceReportRecord.run_id, func.count(RunTraceReportRecord.id))
                        .where(RunTraceReportRecord.run_id.in_(terminal_run_ids))
                        .group_by(RunTraceReportRecord.run_id)
                    )
                ).all()
                if terminal_run_ids
                else []
            )
            report_counts: dict[str, int] = {str(row[0]): int(row[1]) for row in report_count_rows}
        missing = [run_id for run_id in terminal_run_ids if int(report_counts.get(run_id, 0)) != 2]
        for run_id in missing:
            async with self.database.sessions.begin() as transaction:
                run = await transaction.get(RunRecord, run_id)
                if run is not None and run.status in TERMINAL_RUN_STATUSES:
                    await self._materialize_trace_reports(transaction, run)
        return len(missing)

    async def latest_workflow_trace(self, session_id: str, workflow_id: str) -> list[dict[str, Any]]:
        """返回某Workflow最近一次已结束Run的Trace投影，供工作台刷新后恢复节点终态。"""

        async with self.database.sessions() as transaction:
            await self._session(transaction, session_id)
            starts = list(
                (
                    await transaction.scalars(
                        select(TraceRecord)
                        .where(
                            TraceRecord.session_id == session_id,
                            TraceRecord.event_type == "workflow.started",
                        )
                        .order_by(TraceRecord.created_at.desc())
                    )
                ).all()
            )
            latest = next(
                (
                    value
                    for value in starts
                    if isinstance(value.payload, dict) and value.payload.get("workflow_id") == workflow_id
                ),
                None,
            )
            if latest is None or latest.run_id is None:
                return []
            values = list(
                (
                    await transaction.scalars(
                        select(TraceRecord)
                        .where(
                            TraceRecord.session_id == session_id,
                            TraceRecord.run_id == latest.run_id,
                        )
                        .order_by(TraceRecord.sequence)
                    )
                ).all()
            )
        return [_trace_view(value) for value in values]

    async def record_trace(
        self,
        session_id: str,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """追加一条Product Trace：Run内数据库原子计数器分配sequence，并发写入连续唯一。"""

        async with self.database.trace_write_lock:
            async with self.database.sessions.begin() as transaction:
                await self._session(transaction, session_id)
                run = await transaction.scalar(
                    select(RunRecord).where(
                        RunRecord.id == run_id,
                        RunRecord.session_id == session_id,
                    )
                )
                if run is None:
                    raise ProductSessionNotFound("Product Run不存在")
                await self._trace(transaction, run, event_type, payload)

    # BP-04 触发：Product Run的创建与幂等复核入口。第1次由durable_agent_endpoint调用：
    # 创建Message/Interaction/Run/Attempt。第2次由ProductAwareWorkflow.run调用：幂等复用原Run。
    # 对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#4a和#4b
    async def prepare_agui_run(self, input_data: dict[str, Any]) -> AcceptedRun:
        """AG-UI接纳门：先校验与幂等，再把Interaction/User Message/Product Run/Runtime Job同事务落库。

        Product Run的创建与幂等复核入口。第1次由durable_agent_endpoint调用：创建
        Message/Interaction/Run/Attempt。第2次由ProductAwareWorkflow.run调用：幂等复用原Run。
        两次调用都经过相同的校验链，确保幂等性不变。

        依次经过：threadId/runId必填 -> resume分流 -> 相同runId幂等回放（内容漂移则冲突）->
        归档会话拒绝 -> 单活动Run互斥 -> 客户端历史前缀+恰好1条新User消息校验。任一道失败
        都不产生部分状态；通过后Worker才允许领取执行。对应架构“Interaction接纳门”。

        对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#4a和#4b
        """

        # DEBUG-BREAKPOINT-NOTE: BP-04
        # DEBUG-BREAKPOINT-NOTE: 触发: Product Run的创建与幂等复核入口。
        # DEBUG-BREAKPOINT-NOTE: 触发: 第1次由BP-01 durable_agent_endpoint调用：校验并创建Message/Interaction/Run/Attempt等Product事实。
        # DEBUG-BREAKPOINT-NOTE: 触发: 第2次由BP-07 ProductAwareWorkflow.run调用：按相同AG-UI runId与请求Hash幂等复用原Run，不是重复创建。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：从断点停住到知道来路和下一跳#4a和#4b。
        # DEBUG-BREAKPOINT-NOTE: 频率: 新Run触发2次：接纳创建1次+Worker复核1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-04
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
        retry_control = _retry_control(input_data)
        excluded_retry_message_ids: set[str] = set()
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
            retry_source: RunRecord | None = None
            retry_mode: str | None = None
            if retry_control is not None:
                retry_mode, source_run_id = retry_control
                retry_source = await transaction.scalar(
                    select(RunRecord).where(
                        RunRecord.id == source_run_id,
                        RunRecord.session_id == session_id,
                    )
                )
                if retry_source is None:
                    raise ProductSessionConflict("重试来源Run不存在")
                if retry_source.status not in {
                    "failed",
                    "cancelled",
                    "interrupted",
                    "outcome_unknown",
                }:
                    raise ProductSessionConflict("只有失败、取消、中断或结果未知的Run可以重试")
                source_message = await transaction.get(MessageRecord, retry_source.current_user_message_id)
                if source_message is None:
                    raise ProductSessionConflict("重试来源输入不存在")
                if retry_mode == "retry" and current["text"] != _message_text(source_message.content):
                    raise ProductSessionConflict("原样重试不能修改输入；修改后请使用restart")
                ancestor: RunRecord | None = retry_source
                visited_run_ids: set[str] = set()
                while ancestor is not None and ancestor.id not in visited_run_ids:
                    visited_run_ids.add(ancestor.id)
                    excluded_retry_message_ids.add(ancestor.current_user_message_id)
                    ancestor = (
                        await transaction.get(RunRecord, ancestor.retry_of_run_id)
                        if ancestor.retry_of_run_id is not None
                        else None
                    )
            # Withdrawn messages remain durable audit facts but are intentionally
            # absent from the client-visible history. Ordinals therefore advance
            # over every stored message, not only the committed history prefix.
            current_ordinal = await transaction.scalar(
                select(func.max(MessageRecord.ordinal)).where(MessageRecord.session_id == session_id)
            )

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
                    "retry_of_run_id": retry_source.id if retry_source is not None else None,
                    "retry_mode": retry_mode,
                }
            )
            should_auto_title = not persisted and session.title_origin == "default"
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
                        if should_auto_title
                        else session.title
                    ),
                    title_origin="auto" if should_auto_title else session.title_origin,
                    title_source_message_id=(
                        user_message_id if should_auto_title else session.title_source_message_id
                    ),
                )
            )
            if affected_row_count(claimed) != 1:
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
                    retry_of_run_id=retry_source.id if retry_source is not None else None,
                    retry_mode=retry_mode,
                    trace_sequence=1,
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
                    ordinal=int(current_ordinal or 0) + 1,
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
                    payload={
                        "agui_run_id": agui_run_id,
                        "request_hash": request_hash,
                        "retry_of_run_id": retry_source.id if retry_source is not None else None,
                        "retry_mode": retry_mode,
                    },
                )
            )

        await self.replace_input_with_product_history(
            input_data,
            session_id,
            excluded_message_ids=excluded_retry_message_ids,
        )
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

    # BP-05 触发：AG-UI请求携带Resume/interrupt语义并接回活动Product Run时触发。
    # 普通SSE断线、Cursor回放不经过此方法。
    # 对应文档：项目掌握/运行执行与证据/Run-Worker-Cursor-Tool与Workspace怎样恢复.md
    async def _resume_run(self, session_id: str, agui_run_id: str) -> AcceptedRun:
        """恢复门：只允许接回本会话的活动Run；新旧AG-UI runId与Product Run的绑定冲突即拒绝。

        AG-UI请求携带Resume/interrupt语义并接回活动Product Run时触发。普通SSE断线、
        Cursor回放不经过此方法——那些只重放Journal事件，不经过Product Run状态机。

        只允许接回本会话的活动Run；新旧AG-UI runId与Product Run的绑定冲突即拒绝。

        对应文档：项目掌握/运行执行与证据/Run-Worker-Cursor-Tool与Workspace怎样恢复.md
        """

        # DEBUG-BREAKPOINT-NOTE: BP-05
        # DEBUG-BREAKPOINT-NOTE: 触发: AG-UI请求携带Resume/interrupt语义并接回活动Product Run时触发。
        # DEBUG-BREAKPOINT-NOTE: 触发: 普通SSE断线、Cursor回放或前端重新订阅Journal不经过此方法。
        # DEBUG-BREAKPOINT-NOTE: 触发: 不能把传输重连与Workflow Resume混用。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：Run-Worker-Cursor-Tool与Workspace怎样恢复。
        # DEBUG-BREAKPOINT-NOTE: 频率: 仅AG-UI/Product Run恢复语义触发（条件性）
        breakpoint()  # DEBUG-BREAKPOINT: BP-05
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
        self,
        input_data: dict[str, Any],
        session_id: str,
        *,
        excluded_message_ids: set[str] | None = None,
    ) -> None:
        """用Product Store权威历史原位替换AG-UI输入中的客户端消息全集（Retry时排除祖先链）。

        AG-UI Client总是携带浏览器消息；服务端只信自己的committed历史，防止双写与伪造前缀。
        """

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
            if value.id not in (excluded_message_ids or set())
        ]

    async def mark_waiting_approval(
        self,
        session_id: str,
        *,
        draft_id: str | None = None,
        approval_id: str | None = None,
    ) -> None:
        """把活动Run转为waiting_approval并绑定当前Draft/Approval；旧状态非法时静默忽略。"""

        await self._transition_active(
            session_id,
            allowed=ACTIVE_RUN_STATUSES,
            status="waiting_approval",
            draft_id=draft_id,
            approval_id=approval_id,
        )

    async def mark_running(self, session_id: str) -> None:
        """把活动Run标记为running；仅从accepted/waiting_approval/running合法转换。"""

        await self._transition_active(
            session_id,
            allowed={"accepted", "waiting_approval", "running"},
            status="running",
        )

    async def abandon_active_run(self, session_id: str) -> None:
        """用户在治理点放弃：撤回本轮User消息、关闭Run并原子生成双Trace。"""
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
                if session.title_origin == "auto" and session.title_source_message_id == message.id:
                    replacement = await transaction.scalar(
                        select(MessageRecord)
                        .where(
                            MessageRecord.session_id == session_id,
                            MessageRecord.role == "user",
                            MessageRecord.status == "committed",
                            MessageRecord.context_eligible.is_(True),
                            MessageRecord.id != message.id,
                        )
                        .order_by(MessageRecord.ordinal)
                    )
                    if replacement is None:
                        session.title = "新会话"
                        session.title_origin = "default"
                        session.title_source_message_id = None
                    else:
                        replacement_text = _message_text(replacement.content)
                        session.title = replacement_text.strip().replace("\n", " ")[:40] or "新会话"
                        session.title_origin = "auto"
                        session.title_source_message_id = replacement.id
            session.active_run_id = None
            session.revision += 1
            session.updated_at = utc_now()
            await self._trace(transaction, run, "run.abandoned", {})
            await self._materialize_trace_reports(transaction, run)

    async def fail_active_run(
        self,
        session_id: str,
        *,
        status: str = "failed",
        error_code: str | None = None,
        message: str | None = None,
    ) -> None:
        """把活动Run收敛为非成功终态，并在同一事务保存失败原因与双Trace。"""
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
            await self._materialize_trace_reports(transaction, run)

    # BP-06 触发：Product Run成功路径的最终提交门。在数据库事务内写Assistant Message、
    # 成功终态、释放Session、写双Trace。失败/放弃不走此处。
    # 跨边界：MAF->Product提交边界。
    # 对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#10
    async def complete_active_run(
        self,
        session_id: str,
        *,
        assistant_text: str,
        agui_message_id: str | None,
    ) -> dict[str, Any] | None:
        """最终提交门：写Assistant Message、关闭Run并在同一事务生成双Trace。

        Product Run成功路径的最终提交门。在数据库事务内写Assistant Message、成功终态、
        释放Session、写双Trace。失败/放弃不走此处，分别由fail_active_run和abandon_active_run
        收敛。

        跨边界：MAF->Product提交边界。
        对应文档：项目掌握/调试实战/从断点停住到知道来路和下一跳.md#10
        """
        # DEBUG-BREAKPOINT-NOTE: BP-06
        # DEBUG-BREAKPOINT-NOTE: 触发: Product Run成功路径的最终提交门。
        # DEBUG-BREAKPOINT-NOTE: 触发: 在数据库事务内写Assistant Message、成功终态、释放Session、写双Trace。
        # DEBUG-BREAKPOINT-NOTE: 触发: 失败/放弃有各自的收敛方法，不走此处。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：从断点停住到知道来路和下一跳#10（MAF->Product提交边界）。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个成功Run触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-06
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
            await self._materialize_trace_reports(transaction, run)
        return _message_view(message)

    async def active_run(self, session_id: str) -> dict[str, Any] | None:
        """取会话当前活动Run投影；无活动Run返回None，Trace写入据此决定归属。"""
        async with self.database.sessions() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return None
            run = await transaction.get(RunRecord, session.active_run_id)
            return _run_view(run) if run is not None else None

    async def cancel_protocol_run(self, session_id: str, agui_run_id: str) -> dict[str, Any]:
        """把用户取消绑定到精确AG-UI Run；发送后取消收敛为outcome_unknown。"""

        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            protocol = await transaction.scalar(
                select(RunProtocolRecord).where(
                    RunProtocolRecord.session_id == session_id,
                    RunProtocolRecord.agui_run_id == agui_run_id,
                )
            )
            if protocol is None:
                raise ProductSessionNotFound("AG-UI Run映射不存在")
            run = await transaction.get(RunRecord, protocol.product_run_id)
            if run is None:
                raise ProductSessionNotFound("Product Run不存在")
            if run.status not in ACTIVE_RUN_STATUSES:
                # A cancellation racing the normal finalization path is
                # idempotent: report the exact target's durable terminal fact
                # without touching whichever Run may now be active.
                return _run_view(run)
            if session.active_run_id != run.id:
                raise ProductSessionConflict("目标Run不再是当前活动Run")

            previous_status = run.status
            before_dispatch = previous_status in {"accepted", "waiting_approval"}
            status = "cancelled" if before_dispatch else "outcome_unknown"
            failure_code = (
                "user_cancelled_before_dispatch" if before_dispatch else "user_cancelled_after_dispatch"
            )
            failure_message = (
                "用户在Provider发送前取消了Run。"
                if before_dispatch
                else "用户停止等待，但请求可能已经到达Provider，结果需要人工确认。"
            )
            run.status = status
            run.failure_code = failure_code
            run.failure_message = failure_message
            run.finished_at = utc_now()
            await self._finish_attempt(
                transaction,
                run,
                status=status,
                failure_code=failure_code,
                failure_message=failure_message,
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
                {
                    "reason": failure_code,
                    "agui_run_id": agui_run_id,
                    "previous_status": previous_status,
                },
            )
            await self._materialize_trace_reports(transaction, run)
        return _run_view(run)

    async def reconcile_orphaned_runs(self) -> int:
        """启动收敛：把进程丢失遗留的活动Run标为interrupted；有持久Checkpoint安全点的除外。

        本方法只负责“不再有人拥有”的Run；Checkpoint/Interrupt能否跨进程接回由治理桥判断，
        互不冒充。返回收敛数量。
        """

        # 局部导入：让Product Session模块在识别持久MAF安全点的同时，不反向依赖
        # 执行治理的构造链。
        from ..governance.models import (
            MafWorkflowCheckpointRecord,
            RuntimeInterruptLinkRecord,
        )
        from ..runtime_execution.models import RuntimeJobRecord

        interrupted = 0
        async with self.database.sessions.begin() as transaction:
            runs = list(
                (
                    await transaction.scalars(
                        select(RunRecord).where(RunRecord.status.in_(ACTIVE_RUN_STATUSES))
                    )
                ).all()
            )
            for run in runs:
                runtime_job = await transaction.scalar(
                    select(RuntimeJobRecord).where(RuntimeJobRecord.product_run_id == run.id)
                )
                if runtime_job is not None and runtime_job.status in {
                    "queued",
                    "leased",
                    "running",
                    "waiting_human",
                    "waiting_recovery",
                    "cancelling",
                }:
                    # Execution ownership is now process-independent. The
                    # Runtime Reconciler classifies an expired Lease; an API
                    # restart must not destroy an otherwise recoverable Run.
                    continue
                if runtime_job is not None and runtime_job.status in {
                    "failed",
                    "cancelled",
                    "outcome_unknown",
                }:
                    await self._settle_runtime_orphan(
                        transaction,
                        run,
                        status=runtime_job.status,
                        failure_code=runtime_job.failure_code or "runtime_job_terminal",
                        failure_message=runtime_job.failure_summary or "Runtime Job已收敛为非成功终态。",
                    )
                    interrupted += 1
                    continue
                if run.status == "waiting_approval":
                    link = await transaction.scalar(
                        select(RuntimeInterruptLinkRecord).where(
                            RuntimeInterruptLinkRecord.product_run_id == run.id,
                            RuntimeInterruptLinkRecord.status.in_(
                                {"pending", "decision_recorded", "resuming"}
                            ),
                        )
                    )
                    checkpoint = (
                        await transaction.get(MafWorkflowCheckpointRecord, link.maf_checkpoint_id)
                        if link is not None
                        else None
                    )
                    if (
                        checkpoint is not None
                        and checkpoint.product_run_id == run.id
                        and checkpoint.status in {"linked", "resuming"}
                    ):
                        # A waiting approval is deliberately process-independent.
                        # It remains the active Product Run and is restored only
                        # after a version-bound user decision arrives.
                        continue
                await self._settle_runtime_orphan(
                    transaction,
                    run,
                    status="interrupted",
                    failure_code="process_restarted",
                    failure_message="后端进程重启，无法证明此前活动Run已经安全完成。",
                )
                interrupted += 1
        return interrupted

    async def reconcile_terminal_runtime_jobs(self) -> int:
        """把已进入终态的Runtime Job投影到仍活动的Product Run上。

        Runtime只是执行投影；本Product侧方法是Reconciler唯一允许关闭权威Run的位置。
        """

        from ..runtime_execution.models import RuntimeJobRecord

        async with self.database.sessions() as transaction:
            candidates = list(
                (
                    await transaction.execute(
                        select(
                            RunRecord.id,
                            RuntimeJobRecord.status,
                            RuntimeJobRecord.failure_code,
                            RuntimeJobRecord.failure_summary,
                        )
                        .join(
                            RuntimeJobRecord,
                            RuntimeJobRecord.product_run_id == RunRecord.id,
                        )
                        .where(
                            RunRecord.status.in_(ACTIVE_RUN_STATUSES),
                            RuntimeJobRecord.status.in_({"failed", "cancelled", "outcome_unknown"}),
                        )
                    )
                ).all()
            )
        reconciled = 0
        for run_id, status, failure_code, failure_summary in candidates:
            async with self.database.sessions.begin() as transaction:
                claimed = await transaction.scalar(
                    update(RunRecord)
                    .where(
                        RunRecord.id == run_id,
                        RunRecord.status.in_(ACTIVE_RUN_STATUSES),
                    )
                    .values(
                        status=status,
                        failure_code=failure_code or "runtime_job_terminal",
                        failure_message=failure_summary or "Runtime Job已收敛为非成功终态。",
                        finished_at=utc_now(),
                    )
                    .returning(RunRecord.id)
                    .execution_options(synchronize_session=False)
                )
                if claimed is None:
                    continue
                run = await transaction.get(RunRecord, run_id)
                if run is None:
                    continue
                await self._settle_runtime_orphan(
                    transaction,
                    run,
                    status=status,
                    failure_code=failure_code or "runtime_job_terminal",
                    failure_message=failure_summary or "Runtime Job已收敛为非成功终态。",
                )
                reconciled += 1
        return reconciled

    async def _settle_runtime_orphan(
        self,
        transaction: Any,
        run: RunRecord,
        *,
        status: str,
        failure_code: str,
        failure_message: str,
    ) -> None:
        """把孤儿Run/Attempt/Interaction统一收敛为指定终态；调用方持有事务。"""

        run.status = status
        run.failure_code = failure_code
        run.failure_message = failure_message
        run.finished_at = utc_now()
        await self._finish_attempt(
            transaction,
            run,
            status=status,
            failure_code=failure_code,
            failure_message=failure_message,
        )
        interaction = await transaction.get(InteractionRecord, run.interaction_id)
        if interaction is not None:
            interaction.status = status
            interaction.updated_at = utc_now()
        session = await transaction.get(SessionRecord, run.session_id)
        if session is not None and session.active_run_id == run.id:
            session.active_run_id = None
            session.updated_at = utc_now()
        await self._trace(transaction, run, f"run.{status}", {"reason": failure_code})
        await self._materialize_trace_reports(transaction, run)

    async def _materialize_trace_reports(self, transaction: Any, run: RunRecord) -> None:
        """在Run终态事务内物化两份报告，确保终态和报告一起提交。

        该方法只读同一Product Store事务里已经存在的事实。重复调用按
        ``(run_id, report_kind)``更新同一行，既可在终态路径使用，也可给旧Run重建。
        """

        if run.status not in TERMINAL_RUN_STATUSES:
            return
        # ``_trace``刚把终态事件加入当前Unit of Work；先flush，随后查询才能把它
        # 纳入报告的Source Sequence范围，但事务尚未提交，外部读者看不到半份报告。
        await transaction.flush()
        attempts = list(
            (
                await transaction.scalars(
                    select(RunAttemptRecord)
                    .where(RunAttemptRecord.run_id == run.id)
                    .order_by(RunAttemptRecord.attempt_number)
                )
            ).all()
        )
        events = list(
            (
                await transaction.scalars(
                    select(TraceRecord).where(TraceRecord.run_id == run.id).order_by(TraceRecord.sequence)
                )
            ).all()
        )
        tools = list(
            (
                await transaction.scalars(
                    select(ToolExecutionRecord)
                    .where(ToolExecutionRecord.run_id == run.id)
                    .order_by(ToolExecutionRecord.started_at)
                )
            ).all()
        )
        workflow_id: str | None = None
        for event in events:
            payload = event.payload if isinstance(event.payload, Mapping) else {}
            value = payload.get("workflow_id") or payload.get("workflow_definition_id")
            if value:
                workflow_id = str(value)
                break
        definition = self._trace_workflow_definitions.get(workflow_id or "")
        built = build_run_trace_reports(
            run=run,
            attempts=attempts,
            events=events,
            tools=tools,
            workflow_definition=definition,
        )
        first_sequence = events[0].sequence if events else 0
        last_sequence = events[-1].sequence if events else 0
        now = utc_now()
        for report_kind, (content, text) in built.items():
            workflow_value = content.get("workflow")
            workflow: Mapping[str, Any] = workflow_value if isinstance(workflow_value, Mapping) else {}
            existing = await transaction.scalar(
                select(RunTraceReportRecord).where(
                    RunTraceReportRecord.run_id == run.id,
                    RunTraceReportRecord.report_kind == report_kind,
                )
            )
            if existing is None:
                transaction.add(
                    RunTraceReportRecord(
                        id=_uuid(),
                        session_id=run.session_id,
                        run_id=run.id,
                        report_kind=report_kind,
                        schema_version=int(content["schema_version"]),
                        workflow_definition_id=(str(workflow.get("id")) if workflow.get("id") else None),
                        workflow_version=(str(workflow.get("version")) if workflow.get("version") else None),
                        source_first_sequence=first_sequence,
                        source_last_sequence=last_sequence,
                        source_event_count=len(events),
                        content_hash=content_hash(content),
                        content_json=content,
                        content_text=text,
                        created_at=run.finished_at or now,
                        updated_at=now,
                    )
                )
                continue
            existing.schema_version = int(content["schema_version"])
            existing.workflow_definition_id = str(workflow.get("id")) if workflow.get("id") else None
            existing.workflow_version = str(workflow.get("version")) if workflow.get("version") else None
            existing.source_first_sequence = first_sequence
            existing.source_last_sequence = last_sequence
            existing.source_event_count = len(events)
            existing.content_hash = content_hash(content)
            existing.content_json = content
            existing.content_text = text
            existing.updated_at = now

    async def _transition_active(
        self,
        session_id: str,
        *,
        allowed: set[str],
        status: str,
        draft_id: str | None = None,
        approval_id: str | None = None,
    ) -> None:
        """活动Run状态机唯一入口：不在allowed集合内的转换静默忽略，不产生半状态。"""

        async with self.database.sessions.begin() as transaction:
            session = await self._session(transaction, session_id)
            if session.active_run_id is None:
                return
            run = await transaction.get(RunRecord, session.active_run_id)
            if run is None or run.status not in allowed:
                return
            if (
                run.status == status
                and (draft_id is None or run.draft_id == draft_id)
                and (approval_id is None or run.approval_id == approval_id)
            ):
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
        """在当前Scope内取会话记录；调用方持有事务，本方法不自行开启或提交。"""

        value = await transaction.scalar(
            select(SessionRecord).where(
                SessionRecord.id == session_id,
                SessionRecord.scope_id == self.scope_id,
            )
        )
        if value is None:
            raise ProductSessionNotFound("Product Session不存在")
        return value

    async def _current_attempt(self, transaction: Any, run_id: str) -> RunAttemptRecord | None:
        """取Run的最新Attempt（按attempt_number）；恢复与终态写入都以它为所有权对象。"""

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
        """关闭当前Attempt：状态、失败码与完成时间；无Attempt时跳过（旧数据兼容）。"""

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
        """同事务写入Trace：用Run行上的原子计数器分配sequence，并发下连续唯一（不用MAX+1）。"""

        sequence = await transaction.scalar(
            update(RunRecord)
            .where(RunRecord.id == run.id)
            .values(trace_sequence=RunRecord.trace_sequence + 1)
            .returning(RunRecord.trace_sequence)
            .execution_options(synchronize_session=False)
        )
        if sequence is None:
            raise ProductSessionConflict("Product Run的Trace计数器不存在")
        transaction.add(
            TraceRecord(
                id=_uuid(),
                session_id=run.session_id,
                run_id=run.id,
                sequence=int(sequence),
                event_type=event_type,
                payload=payload,
            )
        )

"""SQLAlchemy persistence model for Product Session facts."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

from alembic import command
from alembic.config import Config
from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.engine import CursorResult, Result
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.pool import StaticPool


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def affected_row_count(result: Result[Any]) -> int:
    """Return the DBAPI row count for an UPDATE/DELETE result.

    SQLAlchemy's async ``execute`` annotation exposes the common ``Result``
    surface even though DML returns ``CursorResult`` at runtime. Keeping the
    narrowing here makes optimistic-concurrency checks explicit and avoids
    scattering unchecked casts through application services.
    """

    return cast(CursorResult[Any], result).rowcount


class Base(DeclarativeBase):
    pass


class ProductSessionFactory:
    """Session factory with a test-only writer fence for one SQLite connection."""

    def __init__(self, maker: async_sessionmaker[AsyncSession], *, serialize_writes: bool) -> None:
        self._maker = maker
        self._write_lock = asyncio.Lock() if serialize_writes else None

    def __call__(self) -> AsyncSession:
        return self._maker()

    @asynccontextmanager
    async def begin(self):
        if self._write_lock is None:
            async with self._maker.begin() as transaction:
                yield transaction
            return
        async with self._write_lock:
            async with self._maker.begin() as transaction:
                yield transaction


class SessionRecord(Base):
    __tablename__ = "product_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(32), nullable=False, default="web")
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    title_origin: Mapped[str] = mapped_column(String(20), nullable=False, default="default")
    title_source_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active", index=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active_run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    model_provider_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InteractionRecord(Base):
    __tablename__ = "interactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_message_id: Mapped[str] = mapped_column(String(36), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="accepted")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class RunRecord(Base):
    __tablename__ = "product_runs"
    __table_args__ = (UniqueConstraint("session_id", "initial_agui_run_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    interaction_id: Mapped[str] = mapped_column(
        ForeignKey("interactions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    initial_agui_run_id: Mapped[str] = mapped_column(String(100), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    current_user_message_id: Mapped[str] = mapped_column(String(36), nullable=False)
    assistant_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    model_provider_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    draft_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    approval_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    execution_draft_revision_id: Mapped[str | None] = mapped_column(
        ForeignKey("execution_draft_revisions.id", ondelete="RESTRICT"), nullable=True
    )
    run_spec_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_specs.id", ondelete="RESTRICT"), nullable=True
    )
    retry_of_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    retry_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    trace_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RunAttemptRecord(Base):
    __tablename__ = "run_attempts"
    __table_args__ = (UniqueConstraint("run_id", "attempt_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    runtime_kind: Mapped[str] = mapped_column(String(50), nullable=False, default="in_process")
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_authorization_consumption_id: Mapped[str | None] = mapped_column(
        ForeignKey("authorization_consumptions.id", ondelete="RESTRICT"), nullable=True
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RunProtocolRecord(Base):
    __tablename__ = "run_protocol_ids"
    __table_args__ = (UniqueConstraint("session_id", "agui_run_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agui_run_id: Mapped[str] = mapped_column(String(100), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class MessageRecord(Base):
    __tablename__ = "product_messages"
    __table_args__ = (
        UniqueConstraint("session_id", "ordinal"),
        UniqueConstraint("session_id", "agui_message_id"),
        Index("ix_product_messages_context", "session_id", "context_eligible", "ordinal"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    interaction_id: Mapped[str | None] = mapped_column(
        ForeignKey("interactions.id", ondelete="SET NULL"), nullable=True
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="SET NULL"), nullable=True
    )
    agui_message_id: Mapped[str] = mapped_column(String(100), nullable=False)
    parent_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[Any] = mapped_column(JSON, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="committed")
    context_eligible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    commit_decision_record_id: Mapped[str | None] = mapped_column(
        ForeignKey("decision_records.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class TraceRecord(Base):
    __tablename__ = "trace_events"
    __table_args__ = (UniqueConstraint("run_id", "sequence"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False)
    payload: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)


class AgentProfileRecord(Base):
    """Product-owned editable configuration for one runtime Agent identity."""

    __tablename__ = "agent_profiles"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    provider_id: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class ToolConfigurationRecord(Base):
    """Product-owned, user-editable configuration for a registered Tool."""

    __tablename__ = "tool_configurations"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    provider_id: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    working_directory: Mapped[str] = mapped_column(Text, nullable=False)
    allowed_tools: Mapped[Any] = mapped_column(JSON, nullable=False, default=list)
    thinking_level: Mapped[str] = mapped_column(String(32), nullable=False, default="medium")
    max_model_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=12)
    timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=900)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )


class ToolExecutionRecord(Base):
    """Observable product ledger for one external Tool runtime execution."""

    __tablename__ = "tool_executions"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "tool_id",
            "execution_ordinal",
            name="uq_tool_execution_run_tool_ordinal",
        ),
        Index(
            "ix_tool_execution_runtime_job_status",
            "runtime_job_id",
            "status",
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("product_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("product_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_attempt_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_attempts.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    runtime_job_id: Mapped[str | None] = mapped_column(
        ForeignKey("runtime_jobs.id", ondelete="RESTRICT"), nullable=True
    )
    run_spec_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_specs.id", ondelete="RESTRICT"), nullable=True
    )
    step_input_projection_id: Mapped[str | None] = mapped_column(
        ForeignKey("step_input_projections.id", ondelete="RESTRICT"), nullable=True
    )
    repository_binding_id: Mapped[str | None] = mapped_column(
        ForeignKey("project_repository_bindings.id", ondelete="RESTRICT"), nullable=True
    )
    repository_snapshot_id: Mapped[str | None] = mapped_column(
        ForeignKey("repository_snapshots.id", ondelete="RESTRICT"), nullable=True
    )
    tool_id: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    execution_ordinal: Mapped[int | None] = mapped_column(Integer, nullable=True)
    mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    config_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    input_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    capability_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_activity_sequence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    process_dispatch_state: Mapped[str] = mapped_column(String(32), nullable=False, default="not_started")
    model_call_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    internal_tool_call_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    terminal_reason_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    tool_call_request_id: Mapped[str | None] = mapped_column(
        ForeignKey("tool_call_requests.id", ondelete="RESTRICT"), nullable=True
    )
    authorization_consumption_id: Mapped[str | None] = mapped_column(
        ForeignKey("authorization_consumptions.id", ondelete="RESTRICT"), nullable=True
    )
    metrics: Mapped[Any] = mapped_column(JSON, nullable=False, default=dict)
    result_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    result_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utc_now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ProductDatabase:
    """Own the Product Store engine and transaction factory."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.is_memory = url.endswith(":memory:")
        if url.startswith("sqlite+aiosqlite:///") and not url.endswith(":memory:"):
            database_path = Path(url.removeprefix("sqlite+aiosqlite:///"))
            database_path.parent.mkdir(parents=True, exist_ok=True)
        engine_kwargs: dict[str, Any] = {"pool_pre_ping": True}
        if self.is_memory:
            engine_kwargs["poolclass"] = StaticPool
        self.engine: AsyncEngine = create_async_engine(url, **engine_kwargs)
        if url.startswith("sqlite"):
            event.listen(self.engine.sync_engine, "connect", self._enable_sqlite_integrity)
        session_maker = async_sessionmaker(
            self.engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )
        self.sessions = ProductSessionFactory(
            session_maker,
            serialize_writes=self.is_memory,
        )
        # StaticPool test databases share one physical SQLite connection.
        # MAF may emit stage traces from concurrent executors, so hold this
        # narrow lock through commit instead of allowing two AsyncSessions to
        # interleave transactions on that one connection.
        self.trace_write_lock = asyncio.Lock()

    @staticmethod
    def _enable_sqlite_integrity(dbapi_connection: Any, _: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    async def initialize(self) -> None:
        if self.is_memory:
            # Alembic cannot keep an async in-memory SQLite database alive
            # across the separate migration engine used by env.py. Tests use
            # the exact same metadata while every durable store uses migrations.
            async with self.engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            return
        await asyncio.to_thread(self._upgrade_schema)

    def _upgrade_schema(self) -> None:
        project_root = Path(__file__).resolve().parents[3]
        configuration = Config(str(project_root / "alembic.ini"))
        configuration.set_main_option("sqlalchemy.url", self.url)
        # Application startup has already installed correlated JSONL handlers.
        # Alembic's CLI logging config must not replace them in-process.
        configuration.attributes["configure_logger"] = False
        command.upgrade(configuration, "head")

    async def close(self) -> None:
        await self.engine.dispose()

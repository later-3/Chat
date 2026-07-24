"""Registered Tool catalog, editable configuration and execution summaries."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from sqlalchemy import select, update

from .config import PiRuntimeSettings
from .model_providers import ModelProviderCatalog, ModelProviderCatalogError
from .product_sessions.database import (
    ProductDatabase,
    ToolConfigurationRecord,
    ToolExecutionRecord,
    affected_row_count,
    utc_now,
)

PI_TOOL_ID = "pi_agent"
PI_BUILTIN_TOOLS = ("read", "grep", "find", "ls", "bash", "edit", "write")
PI_THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh")
DEFAULT_PI_SYSTEM_PROMPT = (
    "你是由Chat受控调用的pi coding agent。先理解任务和当前工作目录，"
    "只使用已授权工具完成目标；不要声称未验证的修改或测试已经完成。"
)


class ToolConfigurationError(ValueError):
    code = "TOOL_CONFIGURATION_INVALID"


class ToolConfigurationConflict(ToolConfigurationError):
    code = "TOOL_CONFIGURATION_CONFLICT"


class ToolConfigurationNotFound(ToolConfigurationError):
    code = "TOOL_CONFIGURATION_NOT_FOUND"


@dataclass(frozen=True, slots=True)
class PiToolConfigSnapshot:
    enabled: bool
    provider_id: str
    model: str
    working_directory: str
    allowed_tools: tuple[str, ...]
    thinking_level: str
    max_model_calls: int
    timeout_seconds: int
    system_prompt: str
    revision: int

    def view(self, runtime: PiRuntimeSettings) -> dict[str, Any]:
        return {
            "id": PI_TOOL_ID,
            "name": "pi coding agent",
            "description": "通过pi官方JSONL RPC运行编码Agent；模型调用和内部工具调用逐次审批。",
            "enabled": self.enabled,
            "provider_id": self.provider_id,
            "model": self.model,
            "working_directory": self.working_directory,
            "allowed_tools": list(self.allowed_tools),
            "available_tools": list(PI_BUILTIN_TOOLS),
            "thinking_level": self.thinking_level,
            "thinking_levels": list(PI_THINKING_LEVELS),
            "max_model_calls": self.max_model_calls,
            "timeout_seconds": self.timeout_seconds,
            "system_prompt": self.system_prompt,
            "revision": self.revision,
            "runtime": runtime.public_view(),
        }


def _snapshot(value: ToolConfigurationRecord) -> PiToolConfigSnapshot:
    allowed = value.allowed_tools if isinstance(value.allowed_tools, list) else []
    return PiToolConfigSnapshot(
        enabled=value.enabled,
        provider_id=value.provider_id,
        model=value.model,
        working_directory=value.working_directory,
        allowed_tools=tuple(str(item) for item in allowed),
        thinking_level=value.thinking_level,
        max_model_calls=value.max_model_calls,
        timeout_seconds=value.timeout_seconds,
        system_prompt=value.system_prompt,
        revision=value.revision,
    )


class ToolConfigurationService:
    """Product-owned tool configuration with a startup-owned runtime boundary."""

    def __init__(
        self,
        database: ProductDatabase,
        catalog: ModelProviderCatalog | None,
        runtime: PiRuntimeSettings,
    ) -> None:
        self.database = database
        self.catalog = catalog
        self.runtime = runtime
        self._pi: PiToolConfigSnapshot | None = None

    async def initialize(self) -> None:
        await self.reconcile_orphaned_executions()
        if self.catalog is None:
            self._pi = None
            return
        async with self.database.sessions.begin() as transaction:
            value = await transaction.get(ToolConfigurationRecord, PI_TOOL_ID)
            if value is None:
                value = ToolConfigurationRecord(
                    id=PI_TOOL_ID,
                    enabled=self.runtime.available,
                    provider_id=self.catalog.default_provider_id,
                    model=self.catalog.default_model,
                    working_directory=str(self.runtime.default_working_directory),
                    allowed_tools=["read", "grep", "find", "ls"],
                    thinking_level="medium",
                    max_model_calls=12,
                    timeout_seconds=900,
                    system_prompt=DEFAULT_PI_SYSTEM_PROMPT,
                    revision=1,
                )
                transaction.add(value)
        self._pi = _snapshot(value)

    async def reconcile_orphaned_executions(self) -> int:
        """Close executions whose owning process disappeared before a terminal write."""

        finished_at = utc_now()
        async with self.database.sessions.begin() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(ToolExecutionRecord).where(
                            ToolExecutionRecord.status.in_(("starting", "running", "waiting_human"))
                        )
                    )
                ).all()
            )
            for value in values:
                started_at = value.started_at
                if started_at.tzinfo is None:
                    started_at = started_at.replace(tzinfo=timezone.utc)
                metrics = dict(value.metrics) if isinstance(value.metrics, Mapping) else {}
                metrics["recovery"] = {
                    "status": "interrupted",
                    "reason": "process_restarted",
                }
                value.status = "interrupted"
                value.failure_code = "process_restarted"
                value.finished_at = finished_at
                value.duration_ms = max(
                    value.duration_ms,
                    int((finished_at - started_at).total_seconds() * 1000),
                )
                value.metrics = metrics
        return len(values)

    def runtime_snapshot(self) -> PiToolConfigSnapshot:
        if self._pi is None:
            raise ToolConfigurationNotFound("pi Agent Tool当前不可用")
        if not self._pi.enabled:
            raise ToolConfigurationError("pi Agent Tool已停用")
        if not self.runtime.available:
            raise ToolConfigurationError("pi RPC运行时未完成后端配置")
        return copy.deepcopy(self._pi)

    async def list(self) -> list[dict[str, Any]]:
        return [self._pi.view(self.runtime)] if self._pi is not None else []

    def _validate(
        self,
        *,
        enabled: bool,
        provider_id: str,
        model: str,
        working_directory: str,
        allowed_tools: list[str],
        thinking_level: str,
        max_model_calls: int,
        timeout_seconds: int,
        system_prompt: str,
    ) -> PiToolConfigSnapshot:
        if self.catalog is None:
            raise ToolConfigurationError("当前没有可用于pi Agent的模型Provider")
        try:
            self.catalog.require_selection(provider_id, model)
        except ModelProviderCatalogError as error:
            raise ToolConfigurationError(str(error)) from error
        if enabled and not self.runtime.available:
            raise ToolConfigurationError("pi RPC运行时未完成后端配置，不能启用")
        resolved_directory = Path(working_directory).expanduser().resolve()
        if not resolved_directory.is_dir():
            raise ToolConfigurationError("pi工作目录不存在或不是目录")
        if not any(
            resolved_directory == root or resolved_directory.is_relative_to(root)
            for root in self.runtime.allowed_working_roots
        ):
            raise ToolConfigurationError("pi工作目录不在后端允许范围内")
        if not allowed_tools or len(allowed_tools) != len(set(allowed_tools)):
            raise ToolConfigurationError("pi至少需要一个不重复的内部Tool")
        unknown = sorted(set(allowed_tools) - set(PI_BUILTIN_TOOLS))
        if unknown:
            raise ToolConfigurationError(f"pi不支持这些内部Tool: {', '.join(unknown)}")
        if thinking_level not in PI_THINKING_LEVELS:
            raise ToolConfigurationError("pi thinking level无效")
        if not 1 <= max_model_calls <= 100:
            raise ToolConfigurationError("max_model_calls必须在1到100之间")
        if not 30 <= timeout_seconds <= 3600:
            raise ToolConfigurationError("timeout_seconds必须在30到3600之间")
        clean_prompt = system_prompt.strip()
        if not clean_prompt:
            raise ToolConfigurationError("pi System Prompt不能为空")
        return PiToolConfigSnapshot(
            enabled=enabled,
            provider_id=provider_id,
            model=model,
            working_directory=str(resolved_directory),
            allowed_tools=tuple(allowed_tools),
            thinking_level=thinking_level,
            max_model_calls=max_model_calls,
            timeout_seconds=timeout_seconds,
            system_prompt=clean_prompt,
            revision=0,
        )

    async def update(
        self,
        *,
        expected_revision: int,
        enabled: bool,
        provider_id: str,
        model: str,
        working_directory: str,
        allowed_tools: list[str],
        thinking_level: str,
        max_model_calls: int,
        timeout_seconds: int,
        system_prompt: str,
    ) -> dict[str, Any]:
        validated = self._validate(
            enabled=enabled,
            provider_id=provider_id,
            model=model,
            working_directory=working_directory,
            allowed_tools=allowed_tools,
            thinking_level=thinking_level,
            max_model_calls=max_model_calls,
            timeout_seconds=timeout_seconds,
            system_prompt=system_prompt,
        )
        next_revision = expected_revision + 1
        async with self.database.sessions.begin() as transaction:
            changed = await transaction.execute(
                update(ToolConfigurationRecord)
                .where(
                    ToolConfigurationRecord.id == PI_TOOL_ID,
                    ToolConfigurationRecord.revision == expected_revision,
                )
                .values(
                    enabled=validated.enabled,
                    provider_id=validated.provider_id,
                    model=validated.model,
                    working_directory=validated.working_directory,
                    allowed_tools=list(validated.allowed_tools),
                    thinking_level=validated.thinking_level,
                    max_model_calls=validated.max_model_calls,
                    timeout_seconds=validated.timeout_seconds,
                    system_prompt=validated.system_prompt,
                    revision=next_revision,
                    updated_at=utc_now(),
                )
            )
            if affected_row_count(changed) != 1:
                exists = await transaction.get(ToolConfigurationRecord, PI_TOOL_ID)
                if exists is None:
                    raise ToolConfigurationNotFound("pi Agent Tool配置不存在")
                raise ToolConfigurationConflict("Tool配置已变化，请刷新后再保存")
        self._pi = PiToolConfigSnapshot(
            enabled=validated.enabled,
            provider_id=validated.provider_id,
            model=validated.model,
            working_directory=validated.working_directory,
            allowed_tools=validated.allowed_tools,
            thinking_level=validated.thinking_level,
            max_model_calls=validated.max_model_calls,
            timeout_seconds=validated.timeout_seconds,
            system_prompt=validated.system_prompt,
            revision=next_revision,
        )
        return self._pi.view(self.runtime)

    async def start_execution(
        self,
        *,
        session_id: str,
        run_id: str,
        config_revision: int,
    ) -> str:
        execution_id = str(uuid4())
        async with self.database.sessions.begin() as transaction:
            transaction.add(
                ToolExecutionRecord(
                    id=execution_id,
                    session_id=session_id,
                    run_id=run_id,
                    tool_id=PI_TOOL_ID,
                    config_revision=config_revision,
                    status="running",
                    metrics={},
                )
            )
        return execution_id

    async def finish_execution(
        self,
        execution_id: str,
        *,
        status: str,
        metrics: dict[str, Any],
        failure_code: str | None = None,
    ) -> None:
        async with self.database.sessions.begin() as transaction:
            await transaction.execute(
                update(ToolExecutionRecord)
                .where(ToolExecutionRecord.id == execution_id)
                .values(
                    status=status,
                    model_call_count=int(metrics.get("model_call_count", 0)),
                    internal_tool_call_count=int(metrics.get("internal_tool_call_count", 0)),
                    input_tokens=int(metrics.get("input_tokens", 0)),
                    output_tokens=int(metrics.get("output_tokens", 0)),
                    cache_read_tokens=int(metrics.get("cache_read_tokens", 0)),
                    cache_write_tokens=int(metrics.get("cache_write_tokens", 0)),
                    cost=float(metrics.get("cost", 0.0)),
                    duration_ms=int(metrics.get("duration_ms", 0)),
                    failure_code=failure_code,
                    metrics=copy.deepcopy(metrics),
                    finished_at=utc_now(),
                )
            )

    async def executions(self, limit: int = 20) -> list[dict[str, Any]]:
        async with self.database.sessions() as transaction:
            values = list(
                (
                    await transaction.scalars(
                        select(ToolExecutionRecord)
                        .where(ToolExecutionRecord.tool_id == PI_TOOL_ID)
                        .order_by(ToolExecutionRecord.started_at.desc())
                        .limit(max(1, min(limit, 100)))
                    )
                ).all()
            )
        return [
            {
                "id": value.id,
                "session_id": value.session_id,
                "run_id": value.run_id,
                "tool_id": value.tool_id,
                "config_revision": value.config_revision,
                "status": value.status,
                "model_call_count": value.model_call_count,
                "internal_tool_call_count": value.internal_tool_call_count,
                "tokens": {
                    "input": value.input_tokens,
                    "output": value.output_tokens,
                    "cache_read": value.cache_read_tokens,
                    "cache_write": value.cache_write_tokens,
                },
                "cost": value.cost,
                "duration_ms": value.duration_ms,
                "failure_code": value.failure_code,
                "metrics": copy.deepcopy(value.metrics),
                "started_at": value.started_at.isoformat(),
                "finished_at": value.finished_at.isoformat() if value.finished_at else None,
            }
            for value in values
        ]

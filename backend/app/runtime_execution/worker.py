"""通用Lease型Execution Worker：认领注册过的MAF AG-UI Runner并围栏式写入（链路“Worker领取”段）。

HTTP端点只负责接纳并入队（``runtime_execution/endpoint.py``）；本模块在独立循环里
逐个领取Runtime Job、续租、执行Runner并写事件Journal。Lease Epoch保证旧Worker失去
所有权后不能再写事件或终态——对应阶段5活动流与Worker恢复边界。
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import socket
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Any, Protocol

from sqlalchemy import select

from ..observability.context import bind_context
from ..observability.metrics import metrics
from ..observability.tracing import tracer
from ..product_sessions.database import ProductDatabase, RunRecord, utc_now
from ..product_sessions.service import ProductSessionService
from .models import ExecutionWorkerRecord
from .service import ClaimedRuntime, RuntimeExecutionService, RuntimeLeaseLost

logger = logging.getLogger(__name__)


class RuntimeRunner(Protocol):
    """Worker可调用的运行器协议：输入AG-UI请求数据，产出异步事件流（如ProductAwareWorkflow）。"""

    def run(self, input_data: dict[str, Any]) -> AsyncIterator[Any]:
        """执行一轮AG-UI Run并异步产出事件；由Worker在Lease保护下驱动到终态。"""
        ...


class RuntimeRunnerRegistry:
    """组合根处的Runner注册表；持久化Job只保存版本化endpoint key。

    进程重启后Worker按key找回Runner实现；同一key注册不同实例直接失败，防止双实现漂移。
    """

    def __init__(self) -> None:
        """初始化空注册表；Runner只在组合根注册，运行期不允许替换。"""

        self._runners: dict[str, RuntimeRunner] = {}

    def register(self, endpoint_key: str, runner: RuntimeRunner) -> None:
        """按endpoint key注册Runner；同key重复注册不同实例立即失败，防止双实现漂移。"""

        existing = self._runners.get(endpoint_key)
        if existing is not None and existing is not runner:
            raise ValueError(f"Runtime endpoint重复注册: {endpoint_key}")
        self._runners[endpoint_key] = runner

    def require(self, endpoint_key: str) -> RuntimeRunner:
        """按Job中的key取出Runner；未注册即失败，Worker不猜测默认实现。"""

        try:
            return self._runners[endpoint_key]
        except KeyError as error:
            raise RuntimeError(f"Execution Worker不支持Runtime endpoint: {endpoint_key}") from error

    @property
    def capabilities(self) -> tuple[str, ...]:
        """返回已注册endpoint key集合，供健康投影展示Worker可执行能力。"""

        return tuple(sorted(self._runners))


class ExecutionWorker:
    """一次只领一个Job的通用执行Worker；所有持久写入按Lease Epoch围栏。

    失联或崩溃时Lease过期，Reconciler按“未外发安全重领/已终结修复/结果未知”三类收敛；
    旧Epoch即使恢复也不能再写事件或终态。
    """

    def __init__(
        self,
        database: ProductDatabase,
        *,
        runtime: RuntimeExecutionService,
        registry: RuntimeRunnerRegistry,
        worker_id: str,
        lease_seconds: int = 30,
        sessions: ProductSessionService | None = None,
    ) -> None:
        """注入数据库、领取服务、Runner注册表与Worker身份；lease过短无法安全续租，直接拒绝。"""

        if lease_seconds < 3:
            raise ValueError("Execution Worker lease_seconds必须至少为3")
        self.database = database
        self.runtime = runtime
        self.registry = registry
        self.worker_id = worker_id
        self.lease_seconds = lease_seconds
        self.sessions = sessions or ProductSessionService(database)
        self.boot_id = str(uuid.uuid4())
        self._next_maintenance_at = 0.0

    async def register(self) -> None:
        """启动时登记Worker身份（boot_id/host/pid），供Reconciler区分新旧实例。"""

        async with self.database.sessions.begin() as transaction:
            record = await transaction.get(ExecutionWorkerRecord, self.worker_id)
            values = {
                "boot_id": self.boot_id,
                "host": socket.gethostname(),
                "pid": os.getpid(),
                "version": "1.0.0",
                "capabilities_json": {
                    "endpoints": list(self.registry.capabilities),
                    "python": platform.python_version(),
                },
                "status": "ready",
                "started_at": utc_now(),
                "heartbeat_at": utc_now(),
                "stopped_at": None,
            }
            if record is None:
                transaction.add(ExecutionWorkerRecord(id=self.worker_id, **values))
            else:
                for key, value in values.items():
                    setattr(record, key, value)

    async def stop(self) -> None:
        """把本boot实例标记为stopped；不强制中断正在执行的Job，由Lease过期兜底。"""

        async with self.database.sessions.begin() as transaction:
            record = await transaction.get(ExecutionWorkerRecord, self.worker_id)
            if record is not None and record.boot_id == self.boot_id:
                record.status = "stopped"
                record.heartbeat_at = utc_now()
                record.stopped_at = utc_now()

    async def run_once(self) -> bool:
        """执行一轮：先维护（Lease对账/心跳）再原子领取1个Job并执行；空闲返回False。"""

        # DEBUG-BREAKPOINT-NOTE: BP-02
        # DEBUG-BREAKPOINT-NOTE: 触发: Worker主循环每轮执行时触发。
        # DEBUG-BREAKPOINT-NOTE: 触发: 先做Lease对账/心跳维护，再尝试原子领取1个Job。
        # DEBUG-BREAKPOINT-NOTE: 触发: 注意：即使没有待处理Job也会触发（空闲时claim返回None后直接返回False）。
        # DEBUG-BREAKPOINT-NOTE: 触发: 在Chat Full Stack配置下Worker内嵌启动，后台循环会定期调用此方法，因此断点会频繁命中。
        # DEBUG-BREAKPOINT-NOTE: 触发: 如果只想在有Job时暂停，请改用BP-03。
        # DEBUG-BREAKPOINT-NOTE: 频率: Worker循环每轮1次，空闲时也触发（频繁）
        breakpoint()  # DEBUG-BREAKPOINT: BP-02
        await self._maintain_runtime()
        claim = await self.runtime.claim_one(
            worker_id=self.worker_id,
            lease_seconds=self.lease_seconds,
        )
        if claim is None:
            return False
        await self._execute(claim)
        return True

    async def drain(self, *, limit: int = 100) -> int:
        """连续领取直到队列空或达到上限；用于独立Worker进程与测试排水。"""

        processed = 0
        while processed < limit and await self.run_once():
            processed += 1
        return processed

    async def _execute(self, claim: ClaimedRuntime) -> None:
        """驱动一个已领取Job到收敛：绑定日志关联ID与指标，异常按Lease围栏落终态。"""

        started = time.perf_counter()
        metrics.increment("runtime.jobs.claimed")
        with bind_context(
            worker_id=self.worker_id,
            job_id=claim.job_id,
            session_id=str(claim.input_data.get("thread_id") or claim.input_data.get("threadId") or "")
            or None,
            product_run_id=claim.product_run_id,
            attempt_id=claim.run_attempt_id,
            workflow_id=claim.workflow_definition_id,
        ):
            with tracer().start_as_current_span(
                "runtime.job",
                attributes={
                    "runtime.job.id": claim.job_id,
                    "runtime.endpoint": claim.endpoint_key,
                    "runtime.lease.epoch": claim.lease_epoch,
                },
            ) as span:
                try:
                    await self._execute_claim(claim)
                except Exception as error:
                    span.set_attribute("error.type", type(error).__name__)
                    metrics.increment("runtime.jobs.errors")
                    raise
                finally:
                    metrics.observe(
                        "runtime.job.duration_seconds",
                        time.perf_counter() - started,
                    )

    async def _execute_claim(self, claim: ClaimedRuntime) -> None:
        """Job主循环：启动心跳，逐事件写Journal，处理取消命令/中断/终态门。

        取消命令按“产品已取消/结果未知”两类收敛且不自动重试；HITL中断伪装成的
        RUN_FINISHED不算终态；真正终态前先过``_require_product_terminal``提交门。
        """

        # DEBUG-BREAKPOINT-NOTE: BP-03
        # DEBUG-BREAKPOINT-NOTE: 触发: Worker成功领取到一个Job并开始执行时触发。
        # DEBUG-BREAKPOINT-NOTE: 触发: 这是Job主循环入口：启动心跳、逐事件写Journal、处理取消/中断/终态门。
        # DEBUG-BREAKPOINT-NOTE: 触发: 只有当队列中有pending Job且被当前Worker领取时才触发。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个待处理Job触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-03
        heartbeat_task: asyncio.Task[None] | None = None
        terminal_seen = False
        last_control_check = 0.0
        try:
            runner = self.registry.require(claim.endpoint_key)
            await self.runtime.start(
                claim,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
            heartbeat_task = asyncio.create_task(
                self._heartbeat_loop(claim),
                name=f"runtime-heartbeat-{claim.job_id}",
            )
            async for event in runner.run(claim.input_data):
                payload = self._public_payload(event)
                event_type = str(payload.get("type") or "")
                monotonic_now = time.monotonic()
                if monotonic_now - last_control_check >= 0.1 or event_type in {"RUN_FINISHED", "RUN_ERROR"}:
                    last_control_check = monotonic_now
                    cancel_command_id = await self.runtime.pending_cancel_command(claim)
                    if cancel_command_id is not None:
                        product_status = await self.runtime.product_status(claim)
                        runtime_status = "cancelled" if product_status == "cancelled" else "outcome_unknown"
                        message = (
                            "用户已取消本次Run。"
                            if runtime_status == "cancelled"
                            else "用户已停止等待；外部请求结果未知，系统不会自动重试。"
                        )
                        await self.runtime.append_terminal_and_settle(
                            claim,
                            worker_id=self.worker_id,
                            payload={
                                "type": "RUN_ERROR",
                                "code": "USER_CANCELLED"
                                if runtime_status == "cancelled"
                                else "USER_CANCELLED_OUTCOME_UNKNOWN",
                                "message": message,
                            },
                            status=runtime_status,
                            is_terminal=True,
                            failure_code="user_cancelled",
                            failure_summary=message,
                            control_command_ids=(cancel_command_id,),
                        )
                        terminal_seen = True
                        return
                if event_type == "RUN_STARTED":
                    await self.runtime.mark_external_dispatch(claim, worker_id=self.worker_id)
                interrupt = event_type == "RUN_FINISHED" and self._is_interrupt(payload)
                is_terminal = event_type == "RUN_ERROR" or (event_type == "RUN_FINISHED" and not interrupt)
                product_terminal_status: str | None = None
                if is_terminal and event_type == "RUN_FINISHED":
                    product_terminal_status = await self._require_product_terminal(claim)
                if event_type == "RUN_ERROR":
                    terminal_seen = True
                    await self.runtime.append_terminal_and_settle(
                        claim,
                        worker_id=self.worker_id,
                        payload=payload,
                        status="failed",
                        is_terminal=True,
                        failure_code=str(payload.get("code") or "runtime_run_error")[:100],
                        failure_summary=str(payload.get("message") or "MAF Run失败")[:500],
                    )
                elif event_type == "RUN_FINISHED":
                    terminal_seen = True
                    await self.runtime.append_terminal_and_settle(
                        claim,
                        worker_id=self.worker_id,
                        payload=payload,
                        status=(
                            "waiting_human"
                            if interrupt
                            else "cancelled"
                            if product_terminal_status == "abandoned"
                            else "succeeded"
                        ),
                        is_terminal=not interrupt,
                    )
                else:
                    await self.runtime.append_event(
                        claim,
                        worker_id=self.worker_id,
                        payload=payload,
                        is_terminal=False,
                    )
            if not terminal_seen:
                raise RuntimeError("MAF Runtime没有产生RUN_FINISHED或RUN_ERROR")
        except RuntimeLeaseLost:
            logger.warning(
                "execution_worker_lease_lost worker_id=%s job_id=%s epoch=%d",
                self.worker_id,
                claim.job_id,
                claim.lease_epoch,
            )
        except asyncio.CancelledError:
            # The lease expires naturally. Reconciler classifies it using the
            # last persisted external-dispatch state; cancellation is not
            # silently converted into a safe retry.
            raise
        except Exception as error:
            logger.exception(
                "execution_worker_job_failed worker_id=%s job_id=%s",
                self.worker_id,
                claim.job_id,
            )
            await self.runtime.fail_lost_execution(
                claim,
                worker_id=self.worker_id,
                error=error,
            )
        finally:
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat_task

    async def _heartbeat_loop(self, claim: ClaimedRuntime) -> None:
        """执行期间周期续租与心跳；续租失败说明Lease已丢，触发本地收敛而不是继续写。"""
        interval = max(1.0, self.lease_seconds / 3)
        while True:
            await asyncio.sleep(interval)
            alive = await self.runtime.heartbeat(
                claim,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
            if not alive:
                raise RuntimeLeaseLost("Execution Worker续租失败")
            await self._maintain_runtime()

    async def _maintain_runtime(self) -> None:
        """领取间隙的周期维护：对账过期Lease、把Runtime终态投影到Product Run、更新心跳。"""

        now = time.monotonic()
        if now < self._next_maintenance_at:
            return
        self._next_maintenance_at = now + max(1.0, min(10.0, self.lease_seconds / 2))
        summary = await self.runtime.reconcile_expired_leases()
        product_reconciled = await self.sessions.reconcile_terminal_runtime_jobs()
        async with self.database.sessions.begin() as transaction:
            record = await transaction.scalar(
                select(ExecutionWorkerRecord).where(
                    ExecutionWorkerRecord.id == self.worker_id,
                    ExecutionWorkerRecord.boot_id == self.boot_id,
                )
            )
            if record is not None:
                record.heartbeat_at = utc_now()
        if any(summary.values()) or product_reconciled:
            logger.warning(
                "runtime_reconciled worker_id=%s safe_requeued=%d outcome_unknown=%d "
                "product_terminal_recovered=%d product_runs_reconciled=%d",
                self.worker_id,
                summary["safe_requeued"],
                summary["outcome_unknown"],
                summary["product_terminal_recovered"],
                product_reconciled,
            )

    @staticmethod
    def _public_payload(event: Any) -> dict[str, Any]:
        """把Runner事件规范化为可公开Journal载荷；缺AG-UI type的事件直接拒绝。"""

        if hasattr(event, "model_dump"):
            value = event.model_dump(mode="json", by_alias=True, exclude_none=True)
        elif isinstance(event, dict):
            value = dict(event)
        else:
            raise TypeError(f"Runtime事件不可序列化: {type(event).__name__}")
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise TypeError("Runtime事件缺少AG-UI type")
        return value

    @staticmethod
    def _is_interrupt(payload: dict[str, Any]) -> bool:
        """识别“RUN_FINISHED外壳里的HITL中断”：中断是暂停等决定，不是运行终态。"""

        outcome = payload.get("outcome")
        return isinstance(outcome, dict) and outcome.get("type") == "interrupt"

    async def _require_product_terminal(self, claim: ClaimedRuntime) -> str:
        """Finalization门核验：发布成功终态前，Product Run必须已进入产品终态。

        MAF/Runner报完成不等于产品成功；产品事务未提交时这里失败关闭而不是补发成功。
        """

        async with self.database.sessions() as transaction:
            run = await transaction.get(RunRecord, claim.product_run_id)
            if run is None or run.status not in {"succeeded", "abandoned"}:
                raise RuntimeError("Product Run尚未提交可公开终态，禁止发布RUN_FINISHED")
            return run.status

from __future__ import annotations

import asyncio
import multiprocessing
import json
import time
from datetime import timedelta, timezone
from pathlib import Path
from typing import Any

from ag_ui.core import RunFinishedEvent, RunStartedEvent, TextMessageContentEvent, TextMessageEndEvent, TextMessageStartEvent
from sqlalchemy import update
from fastapi.testclient import TestClient

from backend.app.config import PiRuntimeSettings, Settings
from backend.app.main import create_app
from backend.app.product_sessions import ProductDatabase, ProductSessionService
from backend.app.product_sessions.database import utc_now
from backend.app.runtime_execution.models import ExecutionWorkerRecord, RuntimeJobRecord
from backend.app.runtime_execution.service import RuntimeExecutionService, RuntimeLeaseLost
from backend.app.runtime_execution.worker import ExecutionWorker, RuntimeRunnerRegistry


def _request(session_id: str, run_id: str = "runtime-run") -> dict[str, Any]:
    return {
        "thread_id": session_id,
        "run_id": run_id,
        "state": {},
        "messages": [{"id": f"message-{run_id}", "role": "user", "content": "验证Runtime"}],
        "tools": [],
        "context": [],
        "forwarded_props": {},
    }


async def _enqueued(database: ProductDatabase, runtime: RuntimeExecutionService):
    sessions = ProductSessionService(database)
    await sessions.initialize()
    session = await sessions.create_session(title="Runtime验证")
    request = _request(session["id"])
    accepted = await sessions.prepare_agui_run(request)
    queued = await runtime.enqueue(
        accepted=accepted,
        endpoint_key="test",
        workflow_definition_id="test-workflow",
        workflow_version="1.0.0",
        input_data=request,
    )
    return sessions, accepted, queued


class _FakeRunner:
    def __init__(self, sessions: ProductSessionService) -> None:
        self.sessions = sessions

    async def run(self, input_data: dict[str, Any]):
        run_id = str(input_data["run_id"])
        thread_id = str(input_data["thread_id"])
        yield RunStartedEvent(run_id=run_id, thread_id=thread_id)
        yield TextMessageStartEvent(message_id="assistant-runtime", role="assistant")
        yield TextMessageContentEvent(message_id="assistant-runtime", delta="已恢复")
        yield TextMessageEndEvent(message_id="assistant-runtime")
        await self.sessions.complete_active_run(
            thread_id,
            assistant_text="已恢复",
            agui_message_id="assistant-runtime",
        )
        yield RunFinishedEvent(run_id=run_id, thread_id=thread_id)


class _CancelDuringRunRunner:
    def __init__(
        self,
        sessions: ProductSessionService,
        runtime: RuntimeExecutionService,
    ) -> None:
        self.sessions = sessions
        self.runtime = runtime

    async def run(self, input_data: dict[str, Any]):
        run_id = str(input_data["run_id"])
        thread_id = str(input_data["thread_id"])
        yield RunStartedEvent(run_id=run_id, thread_id=thread_id)
        await self.sessions.mark_running(thread_id)
        cancelled = await self.sessions.cancel_protocol_run(thread_id, run_id)
        await self.runtime.request_cancel(
            product_run_id=cancelled["id"],
            request_key=f"cancel:{thread_id}:{run_id}",
        )
        yield TextMessageStartEvent(message_id="must-not-commit", role="assistant")
        yield RunFinishedEvent(run_id=run_id, thread_id=thread_id)


def test_concurrent_claim_has_one_owner_and_stale_epoch_cannot_write(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'claim.db'}")
        runtime = RuntimeExecutionService(database)
        _, _, queued = await _enqueued(database, runtime)

        claims = await asyncio.gather(
            *(runtime.claim_one(worker_id=f"worker-{index}", lease_seconds=30) for index in range(8))
        )
        winners = [value for value in claims if value is not None]
        assert len(winners) == 1
        first = winners[0]
        assert first.lease_epoch == 1

        async with database.sessions.begin() as transaction:
            await transaction.execute(
                update(RuntimeJobRecord)
                .where(RuntimeJobRecord.id == queued.job_id)
                .values(
                    status="queued",
                    lease_owner=None,
                    lease_expires_at=None,
                    available_at=utc_now(),
                )
            )
        second = await runtime.claim_one(worker_id="worker-new", lease_seconds=30)
        assert second is not None
        assert second.lease_epoch == 2
        try:
            await runtime.append_event(
                first,
                worker_id=first.lease_owner,
                payload={"type": "RUN_STARTED", "threadId": "t", "runId": "r"},
                is_terminal=False,
            )
        except RuntimeLeaseLost:
            pass
        else:
            raise AssertionError("旧Lease Epoch不应写入事件")
        await database.close()

    asyncio.run(scenario())


def test_worker_persists_public_events_cursor_and_terminal_state(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'worker.db'}")
        runtime = RuntimeExecutionService(database, cursor_signing_key="test-key")
        sessions, accepted, queued = await _enqueued(database, runtime)
        registry = RuntimeRunnerRegistry()
        registry.register("test", _FakeRunner(sessions))
        worker = ExecutionWorker(
            database,
            runtime=runtime,
            registry=registry,
            worker_id="worker-a",
            lease_seconds=6,
        )

        assert await worker.run_once() is True
        events, job = await runtime.events_after(job_id=queued.job_id, after_sequence=0)
        assert [event["sequence"] for event in events] == [1, 2, 3, 4, 5]
        assert [event["event_type"] for event in events] == [
            "RUN_STARTED",
            "TEXT_MESSAGE_START",
            "TEXT_MESSAGE_CONTENT",
            "TEXT_MESSAGE_END",
            "RUN_FINISHED",
        ]
        assert sum(1 for event in events if event["is_terminal"]) == 1
        assert job["status"] == "succeeded"
        assert job["external_dispatch_state"] == "result_recorded"

        decoded = runtime.decode_cursor(events[2]["cursor"])
        assert decoded["runtime_job_id"] == queued.job_id
        assert decoded["run_attempt_id"] == queued.run_attempt_id
        assert decoded["last_applied_sequence"] == 3
        replay, _ = await runtime.events_after(job_id=queued.job_id, after_sequence=3)
        assert [event["sequence"] for event in replay] == [4, 5]
        assert accepted.product_run_id == job["product_run_id"]
        await database.close()

    asyncio.run(scenario())


def test_expired_lease_is_requeued_only_before_external_dispatch(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'reconcile.db'}")
        runtime = RuntimeExecutionService(database)
        sessions, accepted, queued = await _enqueued(database, runtime)
        claim = await runtime.claim_one(worker_id="lost-before", lease_seconds=30)
        assert claim is not None
        async with database.sessions.begin() as transaction:
            await transaction.execute(
                update(RuntimeJobRecord)
                .where(RuntimeJobRecord.id == queued.job_id)
                .values(lease_expires_at=utc_now() - timedelta(seconds=1))
            )
        assert await runtime.reconcile_expired_leases() == {
            "safe_requeued": 1,
            "outcome_unknown": 0,
            "product_terminal_recovered": 0,
        }

        claim = await runtime.claim_one(worker_id="lost-after", lease_seconds=30)
        assert claim is not None
        await runtime.start(claim, worker_id="lost-after", lease_seconds=30)
        await runtime.mark_external_dispatch(claim, worker_id="lost-after")
        async with database.sessions.begin() as transaction:
            await transaction.execute(
                update(RuntimeJobRecord)
                .where(RuntimeJobRecord.id == queued.job_id)
                .values(lease_expires_at=utc_now() - timedelta(seconds=1))
            )
        assert await runtime.reconcile_expired_leases() == {
            "safe_requeued": 0,
            "outcome_unknown": 1,
            "product_terminal_recovered": 0,
        }
        job = await runtime.job_for_product_run(claim.product_run_id)
        assert job is not None
        assert job["status"] == "outcome_unknown"
        assert job["failure_code"] == "worker_lease_expired_after_dispatch"
        assert await sessions.reconcile_terminal_runtime_jobs() == 1
        product_runs = await sessions.list_runs(accepted.session_id)
        assert product_runs[0]["status"] == "outcome_unknown"
        await database.close()

    asyncio.run(scenario())


def test_cancel_before_worker_dispatch_is_a_durable_terminal_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'cancel.db'}")
        runtime = RuntimeExecutionService(database)
        _, accepted, queued = await _enqueued(database, runtime)

        result = await runtime.request_cancel(
            product_run_id=accepted.product_run_id,
            request_key="cancel:before-dispatch",
        )
        assert result is not None
        assert result["status"] == "cancelled"
        events, job = await runtime.events_after(job_id=queued.job_id, after_sequence=0)
        assert job["status"] == "cancelled"
        assert [event["event_type"] for event in events] == ["RUN_ERROR"]
        assert events[0]["is_terminal"] is True
        assert events[0]["payload"]["code"] == "USER_CANCELLED_BEFORE_DISPATCH"
        assert await runtime.claim_one(worker_id="too-late", lease_seconds=30) is None
        await database.close()

    asyncio.run(scenario())


def test_reconciler_repairs_runtime_terminal_after_product_commit(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'terminal-repair.db'}")
        runtime = RuntimeExecutionService(database)
        sessions, accepted, queued = await _enqueued(database, runtime)
        claim = await runtime.claim_one(worker_id="lost-after-product-commit", lease_seconds=30)
        assert claim is not None
        await runtime.start(claim, worker_id=claim.lease_owner, lease_seconds=30)
        await runtime.append_event(
            claim,
            worker_id=claim.lease_owner,
            payload={"type": "RUN_STARTED", "threadId": accepted.session_id, "runId": accepted.agui_run_id},
            is_terminal=False,
        )
        await sessions.complete_active_run(
            accepted.session_id,
            assistant_text="Product已提交",
            agui_message_id="assistant-committed",
        )
        async with database.sessions.begin() as transaction:
            await transaction.execute(
                update(RuntimeJobRecord)
                .where(RuntimeJobRecord.id == queued.job_id)
                .values(lease_expires_at=utc_now() - timedelta(seconds=1))
            )

        assert await runtime.reconcile_expired_leases() == {
            "safe_requeued": 0,
            "outcome_unknown": 0,
            "product_terminal_recovered": 1,
        }
        events, job = await runtime.events_after(job_id=queued.job_id, after_sequence=0)
        assert job["status"] == "succeeded"
        assert [event["event_type"] for event in events] == ["RUN_STARTED", "RUN_FINISHED"]
        assert events[-1]["payload"]["recoveredBy"] == "runtime_reconciler"
        assert events[-1]["is_terminal"] is True
        await database.close()

    asyncio.run(scenario())


def test_competing_reconcilers_append_one_terminal_event(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'reconcile-race.db'}")
        runtime = RuntimeExecutionService(database)
        sessions, _, queued = await _enqueued(database, runtime)
        claim = await runtime.claim_one(worker_id="expired-owner", lease_seconds=30)
        assert claim is not None
        await runtime.start(claim, worker_id=claim.lease_owner, lease_seconds=30)
        await runtime.mark_external_dispatch(claim, worker_id=claim.lease_owner)
        async with database.sessions.begin() as transaction:
            await transaction.execute(
                update(RuntimeJobRecord)
                .where(RuntimeJobRecord.id == queued.job_id)
                .values(lease_expires_at=utc_now() - timedelta(seconds=1))
            )

        summaries = await asyncio.gather(
            runtime.reconcile_expired_leases(),
            runtime.reconcile_expired_leases(),
        )
        assert sum(value["outcome_unknown"] for value in summaries) == 1
        product_results = await asyncio.gather(
            sessions.reconcile_terminal_runtime_jobs(),
            sessions.reconcile_terminal_runtime_jobs(),
        )
        assert sum(product_results) == 1
        events, job = await runtime.events_after(job_id=queued.job_id, after_sequence=0)
        assert job["status"] == "outcome_unknown"
        assert len([event for event in events if event["is_terminal"]]) == 1
        await database.close()

    asyncio.run(scenario())


def test_idle_worker_maintenance_refreshes_observable_heartbeat(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'worker-heartbeat.db'}")
        runtime = RuntimeExecutionService(database)
        await runtime.initialize()
        registry = RuntimeRunnerRegistry()
        worker = ExecutionWorker(
            database,
            runtime=runtime,
            registry=registry,
            worker_id="idle-worker",
            lease_seconds=6,
        )
        await worker.register()
        async with database.sessions.begin() as transaction:
            record = await transaction.get(ExecutionWorkerRecord, "idle-worker")
            assert record is not None
            old_heartbeat = utc_now() - timedelta(minutes=5)
            record.heartbeat_at = old_heartbeat

        assert await worker.run_once() is False
        async with database.sessions() as transaction:
            record = await transaction.get(ExecutionWorkerRecord, "idle-worker")
            assert record is not None
            refreshed = record.heartbeat_at
            if refreshed.tzinfo is None:
                refreshed = refreshed.replace(tzinfo=timezone.utc)
            assert refreshed > old_heartbeat
        await database.close()

    asyncio.run(scenario())


def test_running_cancel_is_consumed_without_publishing_success(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'running-cancel.db'}")
        runtime = RuntimeExecutionService(database)
        sessions, accepted, queued = await _enqueued(database, runtime)
        registry = RuntimeRunnerRegistry()
        registry.register("test", _CancelDuringRunRunner(sessions, runtime))
        worker = ExecutionWorker(
            database,
            runtime=runtime,
            registry=registry,
            worker_id="cancel-worker",
            lease_seconds=6,
        )

        assert await worker.run_once() is True
        events, job = await runtime.events_after(job_id=queued.job_id, after_sequence=0)
        assert job["status"] == "outcome_unknown"
        assert events[-1]["event_type"] == "RUN_ERROR"
        assert events[-1]["payload"]["code"] == "USER_CANCELLED_OUTCOME_UNKNOWN"
        assert all(event["event_type"] != "RUN_FINISHED" for event in events)
        product_runs = await sessions.list_runs(accepted.session_id)
        assert product_runs[0]["status"] == "outcome_unknown"
        product_messages = await sessions.list_messages(accepted.session_id)
        assert [message["role"] for message in product_messages] == ["user"]
        await database.close()

    asyncio.run(scenario())


def _process_claim(database_url: str, worker_id: str, start, results) -> None:
    async def claim() -> None:
        database = ProductDatabase(database_url)
        runtime = RuntimeExecutionService(database)
        start.wait(timeout=10)
        value = await runtime.claim_one(worker_id=worker_id, lease_seconds=30)
        results.put(None if value is None else (value.job_id, value.lease_epoch, worker_id))
        await database.close()

    asyncio.run(claim())


def test_two_os_processes_cannot_claim_the_same_attempt(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'process-claim.db'}"

    async def prepare() -> None:
        database = ProductDatabase(database_url)
        runtime = RuntimeExecutionService(database)
        await _enqueued(database, runtime)
        await database.close()

    asyncio.run(prepare())
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    results = context.Queue()
    processes = [
        context.Process(target=_process_claim, args=(database_url, f"process-{index}", start, results))
        for index in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    values = [results.get(timeout=15) for _ in processes]
    for process in processes:
        process.join(timeout=15)
        assert process.exitcode == 0
    assert len([value for value in values if value is not None]) == 1


def test_http_disconnect_does_not_cancel_worker_and_cursor_replays_rest(tmp_path: Path) -> None:
    settings = Settings(
        host="127.0.0.1",
        port=8030,
        frontend_origins=("http://testserver",),
        model="test/bootstrap",
        model_api_key=None,
        model_base_url=None,
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'disconnect.db'}",
        pi_runtime=PiRuntimeSettings(),
    )
    app = create_app(settings)
    with TestClient(app) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        with client.stream(
            "POST",
            "/api/agent",
            json={
                "threadId": session_id,
                "runId": "disconnect-run",
                "state": {},
                "messages": [{"id": "disconnect-user", "role": "user", "content": "断线后继续"}],
                "tools": [],
                "context": [],
                "forwardedProps": {},
            },
        ) as response:
            assert response.status_code == 200
            job_id = response.headers["x-runtime-job-id"]
            initial_cursor = response.headers["x-runtime-cursor"]
            first_event = next(
                json.loads(line.removeprefix("data: "))
                for line in response.iter_lines()
                if line.startswith("data: ")
            )
            assert first_event["type"] == "RUN_STARTED"
            # Leaving the response context closes only this subscriber.

        deadline = time.monotonic() + 5
        job: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            product_run_id = client.get(
                f"/api/sessions/{session_id}/runs"
            ).json()["runs"][0]["id"]
            job = client.get(
                f"/api/runtime/product-runs/{product_run_id}"
            ).json()["job"]
            if job["status"] == "succeeded":
                break
            time.sleep(0.03)
        assert job is not None
        assert job["status"] == "succeeded"

        replay = client.get(
            f"/api/runtime/jobs/{job_id}/events",
            params={"cursor": initial_cursor},
        )
        assert replay.status_code == 200, replay.text
        payload = replay.json()
        assert [event["sequence"] for event in payload["events"]] == list(
            range(1, job["last_event_sequence"] + 1)
        )
        assert payload["events"][-1]["event_type"] == "RUN_FINISHED"
        assert payload["events"][-1]["is_terminal"] is True
        assert client.get(f"/api/sessions/{session_id}/messages").json()["messages"][-1]["role"] == "assistant"

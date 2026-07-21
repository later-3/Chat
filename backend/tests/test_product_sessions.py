from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.product_sessions import ProductDatabase, ProductSessionService
from backend.app.product_sessions.service import ProductSessionConflict, SessionBusy


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _request(session_id: str, run_id: str, messages: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def test_session_crud_archive_and_configuration_are_server_authoritative() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        created = client.post("/api/sessions", json={"title": "原始标题"})
        assert created.status_code == 201
        session_id = created.json()["id"]

        listed = client.get("/api/sessions").json()["sessions"]
        assert [value["id"] for value in listed] == [session_id]
        assert listed[0]["thread_id"] == session_id

        renamed = client.patch(f"/api/sessions/{session_id}", json={"title": "修订后的标题"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "修订后的标题"
        assert renamed.json()["revision"] == 1

        archived = client.patch(f"/api/sessions/{session_id}", json={"archived": True})
        assert archived.status_code == 200
        assert archived.json()["status"] == "archived"
        assert client.get("/api/sessions").json()["sessions"] == []
        assert len(client.get("/api/sessions?include_archived=true").json()["sessions"]) == 1

        rejected = _events(
            client.post(
                "/api/agent",
                json=_request(
                    session_id,
                    "run-archived",
                    [{"id": "user-archived", "role": "user", "content": "不应运行"}],
                ),
            )
        )
        assert rejected[-1]["type"] == "RUN_ERROR"
        assert rejected[-1]["code"] == "SESSION_CONFLICT"


def test_two_turns_restore_only_product_messages_without_duplicate_history() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _events(
            client.post(
                "/api/agent",
                json=_request(
                    session_id,
                    "run-1",
                    [{"id": "user-1", "role": "user", "content": "第一问"}],
                ),
            )
        )
        assert first[-1]["type"] == "RUN_FINISHED"

        restored = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        assert [value["role"] for value in restored] == ["user", "assistant"]
        messages = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in restored
        ]
        messages.append({"id": "user-2", "role": "user", "content": "第二问"})

        second = _events(client.post("/api/agent", json=_request(session_id, "run-2", messages)))
        assert second[-1]["type"] == "RUN_FINISHED"
        final_messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        assert [value["role"] for value in final_messages] == [
            "user",
            "assistant",
            "user",
            "assistant",
        ]
        assert [value["ordinal"] for value in final_messages] == [1, 2, 3, 4]
        runs = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        assert len(runs) == 2
        assert [attempt["status"] for attempt in runs[0]["attempts"]] == ["succeeded"]


def test_modified_client_history_is_rejected_without_creating_another_run() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        _events(
            client.post(
                "/api/agent",
                json=_request(
                    session_id,
                    "run-1",
                    [{"id": "user-1", "role": "user", "content": "服务端事实"}],
                ),
            )
        )
        restored = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        forged = [
            {"id": value["agui_message_id"], "role": value["role"], "content": value["content"]}
            for value in restored
        ]
        forged[1]["content"] = "篡改后的Assistant历史"
        forged.append({"id": "user-2", "role": "user", "content": "继续"})

        events = _events(client.post("/api/agent", json=_request(session_id, "run-2", forged)))
        assert events[-1] == {
            "type": "RUN_ERROR",
            "message": "客户端历史与Product Store不一致，请重新加载会话",
            "code": "SESSION_HISTORY_CONFLICT",
        }
        assert len(client.get(f"/api/sessions/{session_id}/runs").json()["runs"]) == 1


def test_completed_agui_run_id_cannot_execute_twice() -> None:
    with TestClient(create_app(Settings.for_test())) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        request = _request(
            session_id,
            "run-once",
            [{"id": "user-once", "role": "user", "content": "只执行一次"}],
        )
        assert _events(client.post("/api/agent", json=request))[-1]["type"] == "RUN_FINISHED"

        replay = _events(client.post("/api/agent", json=request))
        assert replay[-1]["type"] == "RUN_ERROR"
        assert replay[-1]["code"] == "IDEMPOTENCY_CONFLICT"
        assert len(client.get(f"/api/sessions/{session_id}/runs").json()["runs"]) == 1
        assert len(client.get(f"/api/sessions/{session_id}/messages").json()["messages"]) == 2


def test_file_store_survives_restart_and_reconciles_unfinished_run(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'restart.db'}"

    async def scenario() -> None:
        first = ProductSessionService(ProductDatabase(database_url))
        await first.initialize()
        session = await first.create_session()
        await first.prepare_agui_run(
            _request(
                session["id"],
                "run-before-restart",
                [{"id": "user-before-restart", "role": "user", "content": "重启前输入"}],
            )
        )
        await first.database.close()

        restored = ProductSessionService(ProductDatabase(database_url))
        await restored.initialize()
        messages = await restored.list_messages(session["id"])
        runs = await restored.list_runs(session["id"])
        session_view = await restored.get_session(session["id"])
        await restored.database.close()

        assert [value["content"] for value in messages] == ["重启前输入"]
        assert runs[0]["status"] == "interrupted"
        assert runs[0]["failure_code"] == "process_restarted"
        assert [attempt["status"] for attempt in runs[0]["attempts"]] == ["interrupted"]
        assert session_view["active_run_id"] is None
        with sqlite3.connect(tmp_path / "restart.db") as connection:
            assert connection.execute("SELECT version_num FROM alembic_version").fetchone() == (
                "36a6de371c70",
            )

    asyncio.run(scenario())


def test_same_session_concurrent_accept_has_one_winner(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'concurrent.db'}"

    async def scenario() -> tuple[int, int]:
        service = ProductSessionService(ProductDatabase(database_url))
        await service.initialize()
        session = await service.create_session()

        async def submit(index: int) -> str:
            try:
                await service.prepare_agui_run(
                    _request(
                        session["id"],
                        f"run-{index}",
                        [{"id": f"user-{index}", "role": "user", "content": f"并发{index}"}],
                    )
                )
                return "accepted"
            except SessionBusy:
                return "busy"

        results = await asyncio.gather(submit(1), submit(2))
        runs = await service.list_runs(session["id"])
        await service.database.close()
        return results.count("accepted"), len(runs)

    assert asyncio.run(scenario()) == (1, 1)


def test_failed_run_retry_and_edited_restart_keep_explicit_lineage(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'retry.db'}"

    async def scenario() -> None:
        service = ProductSessionService(ProductDatabase(database_url))
        await service.initialize()
        session = await service.create_session()
        original = await service.prepare_agui_run(
            _request(
                session["id"],
                "failed-run",
                [{"id": "failed-user", "role": "user", "content": "请重新执行"}],
            )
        )
        await service.fail_active_run(
            session["id"],
            error_code="provider_failed",
            message="Provider明确失败",
        )
        history = await service.list_messages(session["id"])
        retry_request = _request(
            session["id"],
            "retry-run",
            [
                {
                    "id": value["agui_message_id"],
                    "role": value["role"],
                    "content": value["content"],
                }
                for value in history
            ]
            + [{"id": "retry-user", "role": "user", "content": "请重新执行"}],
        )
        retry_request["forwardedProps"] = {
            "sessionControl": {"kind": "retry", "sourceRunId": original.product_run_id}
        }
        retried = await service.prepare_agui_run(retry_request)
        assert [value["content"] for value in retry_request["messages"]] == ["请重新执行"]
        await service.fail_active_run(
            session["id"],
            error_code="retry_failed",
            message="重试仍失败",
        )

        retry_history = await service.list_messages(session["id"])
        restart_request = _request(
            session["id"],
            "restart-run",
            [
                {
                    "id": value["agui_message_id"],
                    "role": value["role"],
                    "content": value["content"],
                }
                for value in retry_history
            ]
            + [{"id": "restart-user", "role": "user", "content": "修改后重新执行"}],
        )
        restart_request["forwardedProps"] = {
            "sessionControl": {"kind": "restart", "sourceRunId": retried.product_run_id}
        }
        restarted = await service.prepare_agui_run(restart_request)
        assert [value["content"] for value in restart_request["messages"]] == ["修改后重新执行"]
        runs = await service.list_runs(session["id"])

        assert runs[0]["id"] == restarted.product_run_id
        assert runs[0]["retry_of_run_id"] == retried.product_run_id
        assert runs[0]["retry_mode"] == "restart"
        assert runs[0]["input_text"] == "修改后重新执行"
        assert runs[1]["retry_of_run_id"] == original.product_run_id
        assert runs[1]["retry_mode"] == "retry"
        assert [value["attempt_number"] for value in runs[1]["attempts"]] == [1]
        assert runs[2]["retry_of_run_id"] is None

        await service.fail_active_run(session["id"], status="cancelled")
        await service.database.close()

    asyncio.run(scenario())


def test_retry_rejects_modified_prompt_without_creating_run(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'invalid-retry.db'}"

    async def scenario() -> None:
        service = ProductSessionService(ProductDatabase(database_url))
        await service.initialize()
        session = await service.create_session()
        source = await service.prepare_agui_run(
            _request(
                session["id"],
                "source-run",
                [{"id": "source-user", "role": "user", "content": "原始输入"}],
            )
        )
        await service.fail_active_run(session["id"], error_code="failed")
        history = await service.list_messages(session["id"])
        invalid = _request(
            session["id"],
            "invalid-retry",
            [
                {
                    "id": value["agui_message_id"],
                    "role": value["role"],
                    "content": value["content"],
                }
                for value in history
            ]
            + [{"id": "invalid-user", "role": "user", "content": "被修改的输入"}],
        )
        invalid["forwardedProps"] = {
            "sessionControl": {"kind": "retry", "sourceRunId": source.product_run_id}
        }
        try:
            await service.prepare_agui_run(invalid)
        except ProductSessionConflict as error:
            assert "restart" in str(error)
        else:
            raise AssertionError("修改后的Prompt不应被记录为原样retry")
        assert len(await service.list_runs(session["id"])) == 1
        assert len(await service.list_messages(session["id"])) == 1
        await service.database.close()

    asyncio.run(scenario())


def test_concurrent_trace_writes_allocate_unique_monotonic_sequences(tmp_path: Path) -> None:
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'trace-concurrency.db'}"

    async def scenario() -> list[dict[str, Any]]:
        service = ProductSessionService(ProductDatabase(database_url))
        await service.initialize()
        session = await service.create_session()
        accepted = await service.prepare_agui_run(
            _request(
                session["id"],
                "trace-run",
                [{"id": "trace-user", "role": "user", "content": "并发Trace"}],
            )
        )
        await asyncio.gather(
            *(
                service.record_trace(
                    session["id"],
                    accepted.product_run_id,
                    "workflow.node",
                    {"index": index},
                )
                for index in range(20)
            )
        )
        traces = await service.list_trace(session["id"], accepted.product_run_id)
        await service.database.close()
        return traces

    traces = asyncio.run(scenario())
    assert [value["sequence"] for value in traces] == list(range(1, 22))
    assert {value["payload"].get("index") for value in traces[1:]} == set(range(20))


def test_alembic_initial_migration_upgrades_and_downgrades_clean_database(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.db"
    configuration = Config("alembic.ini")
    configuration.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{database_path}")

    command.upgrade(configuration, "head")
    with sqlite3.connect(database_path) as connection:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert {
        "product_sessions",
        "interactions",
        "product_messages",
        "product_runs",
        "run_attempts",
        "run_protocol_ids",
        "trace_events",
        "alembic_version",
    } <= tables

    command.downgrade(configuration, "base")
    with sqlite3.connect(database_path) as connection:
        tables_after = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert tables_after <= {"alembic_version"}

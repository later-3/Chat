from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.harness import HarnessService
from backend.app.home import HomeProjectionError, HomeProjectionService
from backend.app.main import create_app
from backend.app.product_sessions.database import InteractionRecord, ProductDatabase
from backend.app.product_sessions.service import ProductSessionService


def test_home_projection_uses_real_product_facts_and_local_calendar_days() -> None:
    async def scenario() -> None:
        now = datetime(2026, 7, 28, 1, 30, tzinfo=timezone.utc)
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        sessions = ProductSessionService(database)
        await sessions.initialize()
        harness = HarnessService(database, clock=lambda: now)
        home = HomeProjectionService(database, clock=lambda: now)

        project = await harness.create_project(
            command_id="home-project",
            kind="delivery",
            title="Chat 主页",
            goal="让持续协作的状态有稳定入口",
            status="active",
        )
        await harness.create_work_item(
            command_id="home-work",
            project_id=project["id"],
            kind="task",
            title="完成真实协作日历",
            objective="按本地日期展示可追溯活动",
            priority="high",
            status="ready",
        )
        await harness.capture_note(
            command_id="home-idea",
            kind="idea",
            title="把每日轨迹变成回到工作的入口",
            content="日历只表示活动，不计算生产力分数。",
            status="draft",
        )
        product_session = await sessions.create_session()
        async with database.sessions.begin() as transaction:
            transaction.add_all(
                [
                    InteractionRecord(
                        id="home-interaction",
                        session_id=product_session["id"],
                        user_message_id="home-message",
                        status="succeeded",
                        created_at=now,
                        updated_at=now,
                    ),
                    InteractionRecord(
                        id="home-abandoned",
                        session_id=product_session["id"],
                        user_message_id="abandoned-message",
                        status="abandoned",
                        created_at=now,
                        updated_at=now,
                    ),
                ]
            )

        overview = await home.overview(year=2026, utc_offset_minutes=480)

        assert overview["today"] == "2026-07-28"
        assert overview["today_summary"] == {
            "open_work_count": 1,
            "collaboration_count": 1,
            "new_idea_count": 1,
            "pending_decision_count": 0,
            "active_run_count": 0,
        }
        assert overview["continue_items"][0]["title"] == "完成真实协作日历"
        assert "progress" not in overview["continue_items"][0]
        assert overview["ideas"][0]["status"] == "draft"
        assert overview["recent_artifacts"] == []
        day = next(item for item in overview["calendar_days"] if item["date"] == "2026-07-28")
        assert day["interaction_count"] == 1
        assert day["work_change_count"] == 2
        assert day["idea_count"] == 1
        assert day["level"] == 3
        assert day["source_count"] >= 3

    asyncio.run(scenario())


def test_home_projection_rejects_unsupported_windows() -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        sessions = ProductSessionService(database)
        await sessions.initialize()
        service = HomeProjectionService(database)
        with pytest.raises(HomeProjectionError):
            await service.overview(year=1999, utc_offset_minutes=0)
        with pytest.raises(HomeProjectionError):
            await service.overview(year=2026, utc_offset_minutes=900)

    asyncio.run(scenario())


def test_home_overview_http_contract_is_read_only_and_bounded() -> None:
    app = create_app(
        Settings.for_test(),
        start_outbox_worker=False,
        start_execution_worker=False,
    )
    with TestClient(app) as client:
        response = client.get("/api/home/overview?year=2026&utc_offset_minutes=480")
        invalid = client.get("/api/home/overview?year=1900&utc_offset_minutes=480")

    assert response.status_code == 200
    assert set(response.json()) == {
        "as_of",
        "year",
        "utc_offset_minutes",
        "today",
        "today_summary",
        "continue_items",
        "calendar_days",
        "recent_artifacts",
        "ideas",
    }
    assert invalid.status_code == 422

from __future__ import annotations

import asyncio
import io
import zipfile
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.harness import HarnessService
from backend.app.harness.projection_queries import HarnessProjectionQueryService
from backend.app.main import create_app
from backend.app.product_sessions import ProductDatabase, ProductSessionService
from backend.app.projections.obsidian import render_obsidian_project_tree
from backend.app.projections.service import ProjectionService


async def _services(
    *, now: datetime
) -> tuple[ProductDatabase, HarnessService, ProjectionService, list[datetime]]:
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    sessions = ProductSessionService(database)
    await sessions.initialize()
    harness = HarnessService(database, clock=lambda: now)
    clock = [now]
    projection = ProjectionService(
        HarnessProjectionQueryService(database),
        clock=lambda: clock[0],
    )
    return database, harness, projection, clock


def test_workspace_reuses_one_project_model_for_work_learning_research_and_life() -> None:
    async def scenario() -> None:
        now = datetime(2026, 7, 30, 8, 0, tzinfo=timezone.utc)
        database, harness, projection, _ = await _services(now=now)
        projects = []
        for index, (kind, title) in enumerate(
            (
                ("delivery", "发布课程"),
                ("learning", "学习英语"),
                ("research", "研究家庭AI设备"),
                ("personal", "安排暑假旅行"),
            )
        ):
            projects.append(
                await harness.create_project(
                    command_id=f"project-{index}",
                    kind=kind,
                    title=title,
                    goal=f"完成{title}",
                    status="active",
                )
            )
        await harness.create_work_item(
            command_id="loose-work",
            kind="task",
            title="缴水费",
            objective="本周完成缴费",
            status="ready",
        )
        standalone_action = await harness.create_action_item(
            command_id="loose-action",
            title="预约体检",
            assignee_kind="user",
            status="ready",
        )

        all_view = await projection.workspace()
        learning_view = await projection.workspace(domain="learning")

        assert all_view["view_schema"] == "personal-workspace.v1"
        assert {value["domain"] for value in all_view["data"]["projects"]} == {
            "work",
            "learning",
            "research",
            "life",
        }
        assert all_view["data"]["independent_work"][0]["classification"] == "unclassified"
        assert "不会猜" in all_view["data"]["independent_work"][0]["classification_reason"]
        assert {value["item_kind"] for value in all_view["data"]["independent_work"]} == {
            "work_item",
            "action_item",
        }
        assert standalone_action["id"] in {value["id"] for value in all_view["data"]["independent_work"]}
        assert [value["id"] for value in learning_view["data"]["projects"]] == [projects[1]["id"]]
        assert learning_view["data"]["independent_work"] == []
        assert learning_view["data"]["summary"]["open_work_count"] == 0
        assert learning_view["data"]["summary"]["open_action_count"] == 0
        assert {value["project_count"] for value in learning_view["data"]["domains"]} == {1}
        assert learning_view["sections"]["learning_schedule"]["state"] == "unknown"
        assert learning_view["sections"]["learning_schedule"]["reason_code"] == ("schedule_not_implemented")
        await database.close()

    asyncio.run(scenario())


def test_workspace_reports_bounded_projection_instead_of_claiming_all_projects() -> None:
    async def scenario() -> None:
        now = datetime(2026, 7, 30, 8, 30, tzinfo=timezone.utc)
        database, harness, projection, _ = await _services(now=now)
        for index in range(101):
            await harness.create_project(
                command_id=f"bounded-project-{index}",
                kind="delivery",
                title=f"Project {index}",
                goal="验证工作台读取上限",
                status="active",
            )

        workspace = await projection.workspace()
        repeated = await projection.workspace()

        assert len(workspace["data"]["projects"]) == 100
        assert repeated["projection_revision"] == workspace["projection_revision"]
        assert workspace["data"]["limits"]["projects_truncated"] is True
        assert workspace["sections"]["projects"]["state"] == "partial"
        assert workspace["sections"]["projects"]["reason_code"] == ("workspace_project_limit_reached")
        await database.close()

    asyncio.run(scenario())


def test_project_dossier_exposes_role_lanes_without_duplicating_plan_nodes() -> None:
    async def scenario() -> None:
        now = datetime(2026, 7, 30, 9, 0, tzinfo=timezone.utc)
        database, harness, projection, _ = await _services(now=now)
        project = await harness.create_project(
            command_id="role-project",
            kind="learning",
            title="英语口语",
            goal="能完成十分钟英文对话",
            status="active",
        )
        work = await harness.create_work_item(
            command_id="role-work",
            project_id=project["id"],
            kind="learning_unit",
            title="自我介绍",
            objective="能流畅完成两分钟自我介绍",
            status="ready",
        )
        plan = await harness.create_plan_revision(
            command_id="role-plan",
            work_item_id=work["id"],
            expected_work_row_version=1,
            summary="先准备，再练习，最后请老师反馈",
            accept=True,
            nodes=[
                {
                    "key": "prepare",
                    "title": "准备个人信息",
                    "objective": "列出自我介绍素材",
                    "assignee_kind": "user",
                },
                {
                    "key": "practice",
                    "title": "生成练习题",
                    "objective": "提供三轮口语练习",
                    "assignee_kind": "agent",
                    "dependencies": ["prepare"],
                },
                {
                    "key": "feedback",
                    "title": "老师反馈",
                    "objective": "请老师指出发音问题",
                    "assignee_kind": "external",
                    "dependencies": ["practice"],
                },
            ],
        )
        agent_node = next(value for value in plan["revision"]["nodes"] if value["assignee_kind"] == "agent")
        await harness.create_action_item(
            command_id="role-action",
            project_id=project["id"],
            work_item_id=work["id"],
            plan_node_id=agent_node["id"],
            title="开始三轮口语练习",
            assignee_kind="agent",
            status="ready",
        )
        await harness.capture_note(
            command_id="role-note",
            kind="learning_note",
            title="发音薄弱点",
            content="th发音需要刻意练习。",
            links=[
                {
                    "resource_kind": "project",
                    "resource_id": project["id"],
                    "relation": "documents",
                }
            ],
        )

        dossier = await projection.project_dossier(project["id"])
        lanes = {value["assignee_kind"]: value for value in dossier["data"]["role_lanes"]}

        assert [value["title"] for value in lanes["user"]["items"]] == ["准备个人信息"]
        assert [value["title"] for value in lanes["agent"]["items"]] == ["开始三轮口语练习"]
        assert [value["title"] for value in lanes["external"]["items"]] == ["老师反馈"]
        assert sum(len(value["items"]) for value in lanes.values()) == 3
        assert dossier["sections"]["evidence"]["state"] == "partial"
        assert dossier["sections"]["artifacts"]["state"] == "unknown"
        assert dossier["data"]["knowledge"]["notes"][0]["title"] == "发音薄弱点"
        assert dossier["permissions"]["authorization_mode"] == "legacy_fixed_scope"
        revision_keys = {
            (
                value["owner"],
                value["resource_kind"],
                value["resource_id"],
                value["revision"],
                value["updated_at"],
            )
            for value in dossier["source_revisions"]
        }
        assert len(revision_keys) == len(dossier["source_revisions"])
        assert "cross_user_view" in {value["capability"] for value in dossier["permissions"]["denied"]}
        await database.close()

    asyncio.run(scenario())


def test_obsidian_tree_and_zip_are_deterministic_and_never_use_titles_as_paths() -> None:
    async def scenario() -> None:
        now = datetime(2026, 7, 30, 10, 0, tzinfo=timezone.utc)
        database, harness, projection, clock = await _services(now=now)
        project = await harness.create_project(
            command_id="obsidian-project",
            kind="personal",
            title="../../儿童:AI\\计划",
            goal="把家庭学习计划整理成可持续行动",
            status="active",
        )
        work = await harness.create_work_item(
            command_id="obsidian-work",
            project_id=project["id"],
            kind="task",
            title="第一周体验",
            objective="完成一次共同创作",
            status="ready",
        )
        await harness.create_action_item(
            command_id="obsidian-action",
            project_id=project["id"],
            work_item_id=work["id"],
            title="选择创作主题",
            assignee_kind="user",
            status="ready",
        )

        dossier_one = await projection.project_dossier(project["id"])
        tree_one = render_obsidian_project_tree(dossier_one)
        clock[0] = now + timedelta(hours=3)
        dossier_two = await projection.project_dossier(project["id"])
        tree_two = render_obsidian_project_tree(dossier_two)

        assert dossier_one["projection_revision"] == dossier_two["projection_revision"]
        assert tree_one.tree_hash == tree_two.tree_hash
        assert tree_one.zip_bytes() == tree_two.zip_bytes()
        assert all(".." not in value.path and "儿童" not in value.path for value in tree_one.files)
        assert f"Projects/{project['id']}/README.md" in {value.path for value in tree_one.files}
        assert f"Projects/{project['id']}/Work/{work['id']}.md" in {value.path for value in tree_one.files}
        with zipfile.ZipFile(io.BytesIO(tree_one.zip_bytes())) as archive:
            names = archive.namelist()
            assert names == sorted(names)
            readme = archive.read(f"Projects/{project['id']}/README.md").decode("utf-8")
            assert "儿童:AI" in readme
            assert "read_only: true" in readme
        await database.close()

    asyncio.run(scenario())


def test_projection_http_contract_supports_dossier_tree_zip_and_etag() -> None:
    app = create_app(
        Settings.for_test(),
        start_outbox_worker=False,
        start_execution_worker=False,
    )
    with TestClient(app) as client:
        project_response = client.post(
            "/api/harness/projects",
            json={
                "command_id": "projection-http-project",
                "kind": "delivery",
                "title": "儿童AI课程",
                "goal": "交付一套可验证的入门课程",
                "status": "active",
            },
        )
        project_id = project_response.json()["id"]
        workspace = client.get("/api/projections/workspace?domain=work")
        dossier = client.get(f"/api/projections/projects/{project_id}/dossier")
        tree = client.get(f"/api/projections/projects/{project_id}/obsidian/tree")
        archive = client.get(f"/api/projections/projects/{project_id}/obsidian.zip")
        not_modified = client.get(
            f"/api/projections/projects/{project_id}/obsidian.zip",
            headers={"If-None-Match": archive.headers["etag"]},
        )
        missing = client.get("/api/projections/projects/not-found/dossier")

    assert project_response.status_code == 201
    assert workspace.status_code == 200
    assert workspace.json()["data"]["projects"][0]["id"] == project_id
    assert dossier.status_code == 200
    assert dossier.headers.get("content-type", "").startswith("application/json")
    assert dossier.headers["x-projection-revision"] == dossier.json()["projection_revision"]
    assert workspace.headers["x-projection-schema-version"] == "1.0"
    assert tree.status_code == 200
    assert tree.json()["read_only"] is True
    assert tree.json()["root_directory"] == f"Projects/{project_id}"
    assert archive.status_code == 200
    assert archive.headers["content-type"] == "application/zip"
    assert archive.headers["x-projection-revision"] == dossier.json()["projection_revision"]
    assert not_modified.status_code == 304
    assert not not_modified.content
    assert missing.status_code == 404
    assert missing.json()["code"] == "PROJECTION_SUBJECT_NOT_FOUND"

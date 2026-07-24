from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import func, select

from backend.app.collaboration_protocols import CollaborationProtocolService
from backend.app.collaboration_protocols.contracts import (
    ProtocolConflict,
    ProtocolValidationError,
)
from backend.app.collaboration_protocols.models import (
    CollaborationProtocolBindingRecord,
    CollaborationProtocolDefinitionRecord,
    CollaborationProtocolRuleRecord,
)
from backend.app.governance.models import GovernanceOutboxRecord
from backend.app.harness.models import HarnessCommandRecord, HarnessTraceRecord
from backend.app.harness.service import HarnessService
from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService


async def _runtime() -> tuple[
    ProductDatabase,
    HarnessService,
    CollaborationProtocolService,
]:
    database = ProductDatabase("sqlite+aiosqlite:///:memory:")
    # Importing and constructing both application services before initialize
    # makes their records part of the test metadata, as in production composition.
    harness = HarnessService(database)
    protocols = CollaborationProtocolService(database)
    await ProductSessionService(database).initialize()
    await protocols.initialize()
    return database, harness, protocols


def test_builtin_protocol_catalog_is_versioned_idempotent_and_complete() -> None:
    async def scenario() -> None:
        database, _, protocols = await _runtime()

        first = await protocols.list_definitions()
        first_bindings = await protocols.list_bindings(scope_kind="system")
        await protocols.initialize()
        second = await protocols.list_definitions()
        second_bindings = await protocols.list_bindings(scope_kind="system")
        configuration = await protocols.configuration()

        assert len(first) == len(second) == 7
        assert len(first_bindings) == len(second_bindings) == 7
        assert {value["protocol_key"] for value in first} == {
            "simple-answer",
            "software-delivery",
            "general-project",
            "standalone-task",
            "learning-loop",
            "research-with-sources",
            "recurring-brief",
        }
        assert all(value["definition_hash"] for value in first)
        assert all(value["rules"] for value in first)
        assert configuration["principal_id"] == "local-user"
        assert len(configuration["protocols"]) == 7
        assert len(configuration["bindings"]) == 7
        assert set(configuration["scenario_kinds"]) == {
            "learning",
            "project",
            "recurring",
            "research",
            "simple_question",
            "software_delivery",
            "task",
        }
        await database.close()

    asyncio.run(scenario())


def test_resolution_uses_work_project_user_system_precedence() -> None:
    async def scenario() -> None:
        database, harness, protocols = await _runtime()
        project = await harness.create_project(
            command_id="protocol-project",
            kind="learning",
            title="系统设计学习",
            goal="持续学习可靠系统设计",
            status="active",
        )
        work = await harness.create_work_item(
            command_id="protocol-work",
            project_id=project["id"],
            kind="learning_unit",
            title="学习Outbox",
            objective="解释并验证Outbox恢复语义",
            status="ready",
        )
        learning = next(
            value for value in await protocols.list_definitions() if value["protocol_key"] == "learning-loop"
        )

        system = await protocols.resolve_for_turn(
            scenario="continue_project",
            project_id=project["id"],
        )
        assert system["scenario_kind"] == "learning"
        assert system["selection_source"] == "system"

        user = await protocols.upsert_binding(
            command_id="bind-user-learning",
            scope_kind="user",
            scope_ref_id="local-user",
            scenario_kind="learning",
            protocol_definition_id=learning["id"],
        )
        assert user["row_version"] == 1
        user_selected = await protocols.resolve_for_turn(
            scenario="continue_project",
            project_id=project["id"],
        )
        assert user_selected["selection_source"] == "user"

        project_binding = await protocols.upsert_binding(
            command_id="bind-project-learning",
            scope_kind="project",
            scope_ref_id=project["id"],
            scenario_kind="learning",
            protocol_definition_id=learning["id"],
        )
        project_selected = await protocols.resolve_for_turn(
            scenario="continue_project",
            project_id=project["id"],
        )
        assert project_selected["selection_source"] == "project"

        await protocols.upsert_binding(
            command_id="bind-work-learning",
            scope_kind="work_item",
            scope_ref_id=work["id"],
            scenario_kind="learning",
            protocol_definition_id=learning["id"],
        )
        work_selected = await protocols.resolve_for_turn(
            scenario="continue_project",
            project_id=project["id"],
            work_item_id=work["id"],
        )
        assert work_selected["selection_source"] == "work_item"
        assert work_selected["binding_id"] != project_binding["id"]
        assert work_selected["selection_hash"]
        assert work_selected["phases"][0]["key"] == "diagnose"
        assert work_selected["applicable_rules"]
        await database.close()

    asyncio.run(scenario())


def test_binding_commands_are_idempotent_cas_guarded_and_audited() -> None:
    async def scenario() -> None:
        database, _, protocols = await _runtime()
        simple = next(
            value for value in await protocols.list_definitions() if value["protocol_key"] == "simple-answer"
        )
        created = await protocols.upsert_binding(
            command_id="bind-user-simple",
            scope_kind="user",
            scope_ref_id="local-user",
            scenario_kind="simple_question",
            protocol_definition_id=simple["id"],
        )
        replay = await protocols.upsert_binding(
            command_id="bind-user-simple",
            scope_kind="user",
            scope_ref_id="local-user",
            scenario_kind="simple_question",
            protocol_definition_id=simple["id"],
        )
        assert replay == created

        with pytest.raises(ProtocolConflict):
            await protocols.upsert_binding(
                command_id="bind-user-simple-stale",
                scope_kind="user",
                scope_ref_id="local-user",
                scenario_kind="simple_question",
                protocol_definition_id=simple["id"],
                expected_row_version=99,
            )
        with pytest.raises(ProtocolValidationError, match="不可关闭"):
            await protocols.upsert_binding(
                command_id="bind-user-simple-disable-required",
                scope_kind="user",
                scope_ref_id="local-user",
                scenario_kind="simple_question",
                protocol_definition_id=simple["id"],
                disabled_rule_keys=[simple["rules"][0]["rule_key"]],
                expected_row_version=created["row_version"],
            )

        async with database.sessions() as transaction:
            command_count = await transaction.scalar(
                select(func.count())
                .select_from(HarnessCommandRecord)
                .where(HarnessCommandRecord.command_kind == "upsert_protocol_binding")
            )
            trace_count = await transaction.scalar(
                select(func.count())
                .select_from(HarnessTraceRecord)
                .where(HarnessTraceRecord.resource_kind == "protocol_binding")
            )
            outbox_count = await transaction.scalar(
                select(func.count())
                .select_from(GovernanceOutboxRecord)
                .where(GovernanceOutboxRecord.aggregate_kind == "protocol_binding")
            )
        assert command_count == trace_count == outbox_count == 1
        await database.close()

    asyncio.run(scenario())


def test_catalog_drift_and_duplicate_resolution_fail_closed() -> None:
    async def scenario() -> None:
        database, _, protocols = await _runtime()
        async with database.sessions.begin() as transaction:
            definition = await transaction.scalar(
                select(CollaborationProtocolDefinitionRecord).where(
                    CollaborationProtocolDefinitionRecord.protocol_key == "simple-answer"
                )
            )
            assert definition is not None
            definition.definition_hash = "tampered"
        with pytest.raises(ProtocolConflict, match="必须发布新revision"):
            await protocols.initialize()

        # Database uniqueness normally prevents duplicates. This assertion
        # verifies that the expected constraints are present in the metadata.
        assert any(
            constraint.name == "uq_protocol_binding_scope_scenario"
            for constraint in CollaborationProtocolBindingRecord.__table__.constraints
        )
        assert {
            "definition_id",
            "rule_key",
        } <= set(CollaborationProtocolRuleRecord.__table__.columns.keys())
        await database.close()

    asyncio.run(scenario())

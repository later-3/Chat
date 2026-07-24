from __future__ import annotations

import asyncio

from backend.app.product_sessions.database import ProductDatabase
from backend.app.product_sessions.service import ProductSessionService
from backend.app.step_inputs import StepInputProjectionService


def test_step_input_projection_is_hash_idempotent_and_revisioned() -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        sessions = ProductSessionService(database)
        service = StepInputProjectionService(database)
        await sessions.initialize()
        session = await sessions.create_session()
        accepted = await sessions.prepare_agui_run(
            {
                "threadId": session["id"],
                "runId": "step-input-run",
                "state": {},
                "messages": [
                    {
                        "id": "step-input-user",
                        "role": "user",
                        "content": "规划下一步",
                    }
                ],
                "tools": [],
                "context": [],
                "forwardedProps": {},
            }
        )
        first = await service.record(
            run_id=accepted.product_run_id,
            workflow_definition_id="continuous-collaboration",
            workflow_version="1.3.0",
            node_id="planning_agent",
            agent_profile_key="task_planner",
            input_value={"goal": "规划下一步"},
            capability_allowlist=[],
            budget={"token_budget": 4200, "model_calls": 1},
            output_contract={"kind": "plan"},
            stop_conditions=["目标不完整时询问"],
        )
        replay = await service.record(
            run_id=accepted.product_run_id,
            workflow_definition_id="continuous-collaboration",
            workflow_version="1.3.0",
            node_id="planning_agent",
            agent_profile_key="task_planner",
            input_value={"goal": "规划下一步"},
            capability_allowlist=[],
            budget={"token_budget": 4200, "model_calls": 1},
            output_contract={"kind": "plan"},
            stop_conditions=["目标不完整时询问"],
        )
        revised = await service.record(
            run_id=accepted.product_run_id,
            workflow_definition_id="continuous-collaboration",
            workflow_version="1.3.0",
            node_id="planning_agent",
            agent_profile_key="task_planner",
            input_value={"goal": "规划下一步", "constraint": "先验证"},
            capability_allowlist=[],
            budget={"token_budget": 4200, "model_calls": 1},
            output_contract={"kind": "plan"},
            stop_conditions=["目标不完整时询问"],
        )
        values = await service.list_for_run(accepted.product_run_id)

        assert replay == first
        assert revised["projection_revision"] == 2
        assert revised["projection_hash"] != first["projection_hash"]
        assert [value["projection_revision"] for value in values] == [1, 2]
        assert values[-1]["input"]["constraint"] == "先验证"
        await database.close()

    asyncio.run(scenario())

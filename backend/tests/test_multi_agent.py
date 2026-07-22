from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator, Awaitable
from typing import Any, Literal, overload

from agent_framework import (
    AgentExecutor,
    AgentResponse,
    AgentResponseUpdate,
    AgentRunInputs,
    AgentSession,
    BaseAgent,
    Content,
    Message,
    ResponseStream,
    WorkflowBuilder,
    WorkflowRunState,
)
from fastapi.testclient import TestClient

from backend.app.agent_profiles import AgentProfileConflict, AgentProfileService
from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.model_call_review import InMemoryModelCallReviewStore, PreparedProviderRequest
from backend.app.model_providers import ModelOption, ModelProviderCatalog, ModelProviderConfig
from backend.app.product_sessions import ProductDatabase


class SequencedTransport:
    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.prepared: list[PreparedProviderRequest] = []

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        self.prepared.append(prepared)
        yield self.responses[len(self.prepared) - 1]


class CapturingAgent(BaseAgent):
    def __init__(self, *, reply: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.reply = reply
        self.seen: list[Message] = []

    @overload
    def run(
        self,
        messages: AgentRunInputs | None = ...,
        *,
        stream: Literal[False] = ...,
        session: AgentSession | None = ...,
        **kwargs: Any,
    ) -> Awaitable[AgentResponse[Any]]: ...

    @overload
    def run(
        self,
        messages: AgentRunInputs | None = ...,
        *,
        stream: Literal[True],
        session: AgentSession | None = ...,
        **kwargs: Any,
    ) -> ResponseStream[AgentResponseUpdate, AgentResponse[Any]]: ...

    def run(
        self,
        messages: AgentRunInputs | None = None,
        *,
        stream: bool = False,
        session: AgentSession | None = None,
        **kwargs: Any,
    ) -> Awaitable[AgentResponse[Any]] | ResponseStream[AgentResponseUpdate, AgentResponse[Any]]:
        del session, kwargs
        self.seen = list(messages or [])  # type: ignore[arg-type]
        if stream:
            async def updates():
                yield AgentResponseUpdate(contents=[Content.from_text(text=self.reply)])

            return ResponseStream(updates(), finalizer=AgentResponse.from_updates)

        async def response() -> AgentResponse[Any]:
            return AgentResponse(messages=[Message("assistant", [self.reply])])

        return response()


def _catalog() -> ModelProviderCatalog:
    provider = ModelProviderConfig(
        id="provider-a",
        label="Provider A",
        models=(
            ModelOption(id="model-a", label="Model A"),
            ModelOption(id="model-b", label="Model B"),
        ),
        base_url="https://provider.invalid/v1",
        api_key="test-key",
    )
    return ModelProviderCatalog(
        providers=(provider,),
        default_provider_id=provider.id,
        default_model="model-a",
    )


def _settings(database_url: str = "sqlite+aiosqlite:///:memory:") -> Settings:
    catalog = _catalog()
    return Settings(
        host="127.0.0.1",
        port=8030,
        frontend_origins=("http://testserver",),
        model="model-a",
        model_api_key="test-key",
        model_base_url="https://provider.invalid/v1",
        model_providers=catalog.providers,
        default_model_provider=catalog.default_provider_id,
        database_url=database_url,
    )


def _request(session_id: str, run_id: str, prompt: str) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": [{"id": f"message-{run_id}", "role": "user", "content": prompt}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }


def _resume(
    session_id: str,
    run_id: str,
    approval_id: str,
    decision: str,
    *,
    revision_draft_id: str | None = None,
) -> dict[str, Any]:
    payload = {"decision": decision}
    if revision_draft_id is not None:
        payload["revision_draft_id"] = revision_draft_id
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": [],
        "tools": [],
        "context": [],
        "forwardedProps": {},
        "resume": [
            {
                "interruptId": approval_id,
                "status": "resolved",
                "payload": payload,
            }
        ],
    }


def _events(response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def _card(events: list[dict[str, Any]]) -> dict[str, Any]:
    finished = [value for value in events if value["type"] == "RUN_FINISHED"][-1]
    interrupt = finished["outcome"]["interrupts"][0]
    return interrupt["metadata"]["agent_framework"]["data"]


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(
        str(value.get("delta") or "")
        for value in events
        if value["type"] == "TEXT_MESSAGE_CONTENT"
    )


def test_installed_maf_agent_executor_full_mode_preserves_user_prompt() -> None:
    async def scenario() -> list[tuple[str, str | None]]:
        first = CapturingAgent(id="first", name="First", reply="规划草稿")
        second = CapturingAgent(id="second", name="Second", reply="最终答复")
        planner = AgentExecutor(first, id="planner", context_mode="full")
        reviewer = AgentExecutor(second, id="reviewer", context_mode="full")
        workflow = (
            WorkflowBuilder(start_executor=planner, output_from=[reviewer])
            .add_edge(planner, reviewer)
            .build()
        )

        async for event in workflow.run("原始用户目标", stream=True):
            if event.type == "status" and event.state == WorkflowRunState.IDLE:
                break
        return [(value.role, value.text) for value in second.seen]

    assert asyncio.run(scenario()) == [
        ("user", "原始用户目标"),
        ("assistant", "规划草稿"),
    ]


def test_agent_profiles_are_editable_with_provider_model_validation_and_revision() -> None:
    with TestClient(create_app(_settings())) as client:
        response = client.get("/api/agents")
        assert response.status_code == 200
        profiles = response.json()["agents"]
        assert {value["id"] for value in profiles} == {
            "planner",
            "reviewer",
            "idiom_agent_a",
            "idiom_agent_b",
        }

        reviewer = next(value for value in profiles if value["id"] == "reviewer")
        updated = client.put(
            "/api/agents/reviewer",
            json={
                "expected_revision": reviewer["revision"],
                "name": "最终审校 Agent",
                "description": "复核规划结果",
                "instructions": "检查完整会话和规划草稿，给出最终答复。",
                "provider_id": "provider-a",
                "model": "model-b",
                "enabled": True,
            },
        )
        stale = client.put(
            "/api/agents/reviewer",
            json={
                "expected_revision": reviewer["revision"],
                "name": "过期修改",
                "description": "",
                "instructions": "不能覆盖新版本",
                "provider_id": "provider-a",
                "model": "model-a",
                "enabled": True,
            },
        )
        invalid_model = client.put(
            "/api/agents/planner",
            json={
                "expected_revision": next(
                    value for value in profiles if value["id"] == "planner"
                )["revision"],
                "name": "规划 Agent",
                "description": "",
                "instructions": "形成规划",
                "provider_id": "provider-a",
                "model": "invented-model",
                "enabled": True,
            },
        )

    assert updated.status_code == 200
    assert updated.json()["model"] == "model-b"
    assert updated.json()["revision"] == reviewer["revision"] + 1
    assert stale.status_code == 409
    assert invalid_model.status_code == 422


def test_agent_profile_concurrent_edits_have_one_revision_winner(tmp_path) -> None:
    async def scenario() -> tuple[int, int]:
        database = ProductDatabase(f"sqlite+aiosqlite:///{tmp_path / 'agents.db'}")
        await database.initialize()
        service = AgentProfileService(database, _catalog())
        await service.initialize()

        async def save(name: str) -> str:
            try:
                await service.update(
                    "planner",
                    expected_revision=1,
                    name=name,
                    description="并发修改",
                    instructions="仍然是有效的规划说明",
                    provider_id="provider-a",
                    model="model-a",
                    enabled=True,
                )
                return "updated"
            except AgentProfileConflict:
                return "conflict"

        results = await asyncio.gather(save("规划A"), save("规划B"))
        planner = next(value for value in await service.list() if value["id"] == "planner")
        await database.close()
        return results.count("updated"), planner["revision"]

    assert asyncio.run(scenario()) == (1, 2)


def test_multi_agent_handoff_requires_two_approvals_and_preserves_full_context(tmp_path) -> None:
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(["规划草稿：先确认范围。", "最终答复：范围已确认，可以执行。"])
    app = create_app(
        _settings(f"sqlite+aiosqlite:///{tmp_path / 'handoff.db'}"),
        model_call_store=store,
        model_call_transport=transport,
    )
    with TestClient(app) as client:
        workflows = client.get("/api/workflows").json()["workflows"]
        assert {value["id"] for value in workflows} == {
            "chat-model-call-approval",
            "nested-quality-demo",
            "governed-agent-handoff",
            "governed-idiom-chain",
        }
        handoff = next(value for value in workflows if value["id"] == "governed-agent-handoff")
        assert [value["runtime_type"] for value in handoff["nodes"]] == [
            "agent",
            "executor",
            "agent",
        ]

        session_id = client.post("/api/sessions", json={}).json()["id"]
        first = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_request(session_id, "handoff-start", "请制定一个交付方案"),
            )
        )
        planner_card = _card(first)
        assert planner_card["execution_context"] == {
            "workflow_id": "governed-agent-handoff",
            "agent_id": "planner",
            "agent_name": "规划 Agent",
            "agent_revision": 1,
            "call_position": 1,
            "total_calls": 2,
        }
        assert transport.prepared == []
        planner_states = [
            value["content"]["status"]
            for value in first
            if value["type"] == "ACTIVITY_SNAPSHOT"
            and value["content"].get("executor_id") == "planner"
        ]
        assert planner_states[-1] == "in_progress"

        second = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_resume(
                    session_id,
                    "handoff-planner-approved",
                    planner_card["approval_id"],
                    "approve",
                ),
            )
        )
        first_reviewer_card = _card(second)
        assert first_reviewer_card["execution_context"]["agent_id"] == "reviewer"
        assert first_reviewer_card["execution_context"]["call_position"] == 2
        assert len(transport.prepared) == 1
        reviewer_states = [
            value["content"]["status"]
            for value in second
            if value["type"] == "ACTIVITY_SNAPSHOT"
            and value["content"].get("executor_id") == "reviewer"
        ]
        assert reviewer_states[-1] == "in_progress"
        reviewer_body = first_reviewer_card["provider_request"]
        reviewer_messages = reviewer_body.get("input", reviewer_body.get("messages", []))
        serialized = json.dumps(reviewer_messages, ensure_ascii=False)
        assert "请制定一个交付方案" in serialized
        assert "规划草稿：先确认范围。" in serialized
        assert "显式交接" in serialized

        edited_reviewer_body = copy.deepcopy(reviewer_body)
        edited_reviewer_body["instructions"] = "用户已修改审校规则：只给最终结论。"
        revised_response = client.put(
            f"/api/model-call-drafts/{first_reviewer_card['draft_id']}",
            json={
                "expected_hash": first_reviewer_card["binding_hash"],
                "provider_id": first_reviewer_card["provider_id"],
                "provider_request": edited_reviewer_body,
            },
        )
        assert revised_response.status_code == 200
        revised = revised_response.json()
        assert revised["version"] == 2
        assert revised["binding_hash"] != first_reviewer_card["binding_hash"]
        revised_events = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_resume(
                    session_id,
                    "handoff-reviewer-revised",
                    first_reviewer_card["approval_id"],
                    "revise",
                    revision_draft_id=revised["draft_id"],
                ),
            )
        )
        reviewer_card = _card(revised_events)
        assert reviewer_card["approval_id"] == revised["approval_id"]
        assert reviewer_card["provider_request"] == edited_reviewer_body
        assert len(transport.prepared) == 1

        completed = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_resume(
                    session_id,
                    "handoff-reviewer-approved",
                    reviewer_card["approval_id"],
                    "approve",
                ),
            )
        )
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        trace = client.get(
            f"/api/sessions/{session_id}/runs/{run['id']}/trace"
        ).json()["trace"]

    assert completed[-1]["type"] == "RUN_FINISHED"
    assert _text(completed) == "最终答复：范围已确认，可以执行。"
    assert len(transport.prepared) == 2
    assert [value.status for value in store.attempts()] == ["completed", "completed"]
    assert [(value["role"], value["content"]) for value in messages] == [
        ("user", "请制定一个交付方案"),
        ("assistant", "最终答复：范围已确认，可以执行。"),
    ]
    assert run["status"] == "succeeded"
    node_events = [value["payload"] for value in trace if value["event_type"] == "workflow.node"]
    assert any(value["executor_id"] == "planner" and value["status"] == "completed" for value in node_events)
    assert any(value["executor_id"] == "handoff" and value["status"] == "completed" for value in node_events)
    assert any(value["executor_id"] == "reviewer" and value["status"] == "completed" for value in node_events)


def test_abandon_first_agent_then_edit_prompt_and_run_again_to_completion(tmp_path) -> None:
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(["修改后的规划", "修改后的最终答复"])
    with TestClient(
        create_app(
            _settings(f"sqlite+aiosqlite:///{tmp_path / 'first-abandon.db'}"),
            model_call_store=store,
            model_call_transport=transport,
        )
    ) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        first_card = _card(
            _events(
                client.post(
                    "/api/workflows/governed-agent-handoff/run",
                    json=_request(session_id, "first-start", "原始Prompt"),
                )
            )
        )
        first_abandoned = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_resume(
                    session_id,
                    "first-abandon",
                    first_card["approval_id"],
                    "abandon",
                ),
            )
        )
        assert first_abandoned[-1]["type"] == "RUN_FINISHED"
        assert store.attempts() == []
        assert transport.prepared == []
        assert client.get(f"/api/sessions/{session_id}/messages").json()["messages"] == []

        planner = _card(
            _events(
                client.post(
                    "/api/workflows/governed-agent-handoff/run",
                    json=_request(session_id, "second-start", "修改后的Prompt"),
                )
            )
        )
        reviewer = _card(
            _events(
                client.post(
                    "/api/workflows/governed-agent-handoff/run",
                    json=_resume(
                        session_id,
                        "second-planner-approved",
                        planner["approval_id"],
                        "approve",
                    ),
                )
            )
        )
        completed = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_resume(
                    session_id,
                    "second-reviewer-approved",
                    reviewer["approval_id"],
                    "approve",
                ),
            )
        )
        runs = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert completed[-1]["type"] == "RUN_FINISHED"
    assert _text(completed) == "修改后的最终答复"
    assert [value["status"] for value in runs] == ["succeeded", "abandoned"]
    assert [(value["role"], value["content"]) for value in messages] == [
        ("user", "修改后的Prompt"),
        ("assistant", "修改后的最终答复"),
    ]
    assert len(store.attempts()) == 2
    assert len(transport.prepared) == 2


def test_abandon_second_agent_stops_workflow_without_fake_success(tmp_path) -> None:
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(["仅有规划草稿"])
    with TestClient(
        create_app(
            _settings(f"sqlite+aiosqlite:///{tmp_path / 'second-abandon.db'}"),
            model_call_store=store,
            model_call_transport=transport,
        )
    ) as client:
        session_id = client.post("/api/sessions", json={}).json()["id"]
        planner = _card(
            _events(
                client.post(
                    "/api/workflows/governed-agent-handoff/run",
                    json=_request(session_id, "abandon-start", "不要丢失原始输入"),
                )
            )
        )
        reviewer = _card(
            _events(
                client.post(
                    "/api/workflows/governed-agent-handoff/run",
                    json=_resume(
                        session_id,
                        "abandon-first-approved",
                        planner["approval_id"],
                        "approve",
                    ),
                )
            )
        )
        assert reviewer["origin_prompt"] == "不要丢失原始输入"
        abandoned = _events(
            client.post(
                "/api/workflows/governed-agent-handoff/run",
                json=_resume(
                    session_id,
                    "abandon-second",
                    reviewer["approval_id"],
                    "abandon",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert run["assistant_message_id"] is None
    # The abandoned interaction stays as a hidden audit fact; the public
    # committed-message projection is empty and the review card carries the
    # original prompt back to the editor.
    assert messages == []
    assert len(store.attempts()) == 1
    assert len(transport.prepared) == 1

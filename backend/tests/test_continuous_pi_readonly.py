from __future__ import annotations

import asyncio
import json
import os
import subprocess
from collections.abc import AsyncIterator, Mapping
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.config import PiRuntimeSettings, Settings, WorkspaceRootSettings
from backend.app.execution_dispatch.contracts import RepositoryFence
from backend.app.main import create_app
from backend.app.model_call_review import (
    InMemoryModelCallReviewStore,
    PreparedProviderRequest,
)
from backend.app.model_providers import (
    ModelOption,
    ModelProviderCatalog,
    ModelProviderConfig,
)
from backend.app.pi_runtime import (
    PiCompletedBoundary,
    PiGatewayCall,
    PiGatewayDecision,
    PiModelCallBoundary,
    PiToolCallBoundary,
)
from backend.app.readonly_tools import ReadonlyToolService
from backend.app.tool_configs import PiToolConfigSnapshot


class SequencedTransport:
    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.prepared: list[PreparedProviderRequest] = []

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        self.prepared.append(prepared)
        yield self.responses[len(self.prepared) - 1]


class FakeReadonlyPiExecution:
    """Deterministic pi boundary source that still executes Chat-owned read tools."""

    def __init__(
        self,
        *,
        provider: ModelProviderConfig,
        config: PiToolConfigSnapshot,
        store: InMemoryModelCallReviewStore,
        fence: RepositoryFence,
        readonly_tools: ReadonlyToolService,
        requested_tool: str = "read",
    ) -> None:
        self.provider = provider
        self.config = config
        self.store = store
        self.fence = fence
        self.readonly_tools = readonly_tools
        self.requested_tool = requested_tool
        self.model_call_count = 0
        self.step = 0
        self.calls: list[PiGatewayCall] = []
        self.tool_results: list[dict[str, Any]] = []
        self.rejected_tool_calls: list[str] = []
        self.closed = False

    def _provider_request(self, *, after_tool: bool = False) -> dict[str, Any]:
        input_items: list[dict[str, Any]] = [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "检查已批准Repository Snapshot中的README。",
                    }
                ],
            }
        ]
        if after_tool:
            input_items.extend(
                [
                    {
                        "type": "function_call",
                        "call_id": "call-read-1",
                        "name": self.requested_tool,
                        "arguments": '{"path":"README.md"}',
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call-read-1",
                        "output": json.dumps(
                            self.tool_results[-1] if self.tool_results else {"denied": True},
                            ensure_ascii=False,
                        ),
                    },
                ]
            )
        return {
            "model": self.config.model,
            "input": input_items,
            "tools": [
                {
                    "type": "function",
                    "name": name,
                    "description": f"Chat-owned {name}",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "additionalProperties": False,
                    },
                    "strict": False,
                }
                for name in self.config.allowed_tools
            ],
            "store": False,
            "stream": True,
            "max_output_tokens": 1000,
        }

    def _model_boundary(self, *, after_tool: bool = False) -> PiModelCallBoundary:
        self.model_call_count += 1
        call = PiGatewayCall(
            id=f"pi-gateway-{self.model_call_count}",
            protocol=self.provider.protocol,
            body=json.dumps(
                self._provider_request(after_tool=after_tool),
                separators=(",", ":"),
            ).encode(),
            received_at=0,
            decision=asyncio.get_running_loop().create_future(),
        )

        def mark_completed(decision: asyncio.Future[PiGatewayDecision]) -> None:
            result = decision.result()
            if result.approved and call.approval_id:
                call.outcome_status = "completed"
                self.store.mark_attempt(call.approval_id, "completed")

        call.decision.add_done_callback(mark_completed)
        self.calls.append(call)
        return PiModelCallBoundary(kind="model_call", call=call)

    async def next_boundary(
        self,
    ) -> PiModelCallBoundary | PiToolCallBoundary | PiCompletedBoundary:
        self.step += 1
        if self.step == 1:
            return self._model_boundary()
        if self.step == 2:
            return PiToolCallBoundary(
                kind="tool_call",
                rpc_request_id="rpc-read-1",
                tool_call_id="tool-read-1",
                tool_name=self.requested_tool,
                arguments={"path": "README.md"},
            )
        if self.step == 3:
            return self._model_boundary(after_tool=True)
        return PiCompletedBoundary(
            kind="completed",
            text="已只读检查README：仓库标题为 Chat。",
            metrics=self.metrics(),
        )

    async def approve_tool_call(
        self,
        boundary: PiToolCallBoundary,
        arguments: Mapping[str, Any],
    ) -> None:
        result = await self.readonly_tools.execute(
            fence=self.fence,
            tool_name=boundary.tool_name,
            arguments=arguments,
        )
        self.tool_results.append(result)

    async def reject_tool_call(self, boundary: PiToolCallBoundary) -> None:
        self.rejected_tool_calls.append(boundary.tool_call_id)

    def metrics(self) -> dict[str, Any]:
        return {
            "model_call_count": self.model_call_count,
            "internal_tool_call_count": 1 if self.step >= 2 else 0,
            "input_tokens": 120,
            "output_tokens": 36,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "cost": 0.01,
            "duration_ms": 1800,
            "tool_calls": [
                {
                    "tool_call_id": "tool-read-1",
                    "tool_name": self.requested_tool,
                    "status": "completed" if self.tool_results else "requested",
                }
            ],
        }

    async def close(self) -> None:
        self.closed = True


class FakeReadonlyPiManager:
    def __init__(
        self,
        provider: ModelProviderConfig,
        store: InMemoryModelCallReviewStore,
        *,
        requested_tool: str = "read",
    ) -> None:
        self.provider = provider
        self.store = store
        self.requested_tool = requested_tool
        self.executions: list[FakeReadonlyPiExecution] = []

    async def start(
        self,
        task: str,
        config: PiToolConfigSnapshot,
        *,
        repository_fence: RepositoryFence | None = None,
        readonly_tools: ReadonlyToolService | None = None,
    ) -> FakeReadonlyPiExecution:
        assert task
        assert config.enabled
        assert repository_fence is not None
        assert readonly_tools is not None
        execution = FakeReadonlyPiExecution(
            provider=self.provider,
            config=config,
            store=self.store,
            fence=repository_fence,
            readonly_tools=readonly_tools,
            requested_tool=self.requested_tool,
        )
        self.executions.append(execution)
        return execution

    async def close_all(self) -> None:
        for execution in self.executions:
            await execution.close()


def _git(cwd: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=True,
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
        },
    )


def _repository(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "Chat Test")
    _git(path, "config", "user.email", "chat-test@example.invalid")
    _git(path, "config", "commit.gpgsign", "false")
    (path / "README.md").write_text("# Chat\n\nSelf development repository.\n", encoding="utf-8")
    _git(path, "add", "README.md")
    _git(path, "commit", "-qm", "initial")
    return path


def _catalog() -> ModelProviderCatalog:
    provider = ModelProviderConfig(
        id="provider-a",
        label="Provider A",
        models=(ModelOption(id="model-a", label="Model A"),),
        base_url="https://provider.invalid/v1",
        api_key="test-key",
        protocol="openai_responses",
    )
    return ModelProviderCatalog(
        providers=(provider,),
        default_provider_id=provider.id,
        default_model="model-a",
    )


def _settings(tmp_path: Path) -> Settings:
    node = tmp_path / "node"
    cli = tmp_path / "pi.js"
    node.touch()
    cli.touch()
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
        database_url=f"sqlite+aiosqlite:///{tmp_path / 'continuous-pi.db'}",
        workspace_roots=(WorkspaceRootSettings(key="code", label="Code", path=tmp_path),),
        pi_runtime=PiRuntimeSettings(
            enabled=True,
            node_path=node,
            cli_path=cli,
            allowed_working_roots=(tmp_path,),
            default_working_directory=tmp_path,
            gateway_origin="http://127.0.0.1:8030",
        ),
    )


def _request(session_id: str, run_id: str, prompt: str) -> dict[str, Any]:
    return {
        "threadId": session_id,
        "runId": run_id,
        "state": {},
        "messages": [
            {"id": f"message-{run_id}", "role": "user", "content": prompt},
        ],
        "tools": [],
        "context": [],
        "forwardedProps": {"workflow": {"id": "continuous-collaboration", "version": "1.7.0"}},
    }


def _resume(
    session_id: str,
    run_id: str,
    card: Mapping[str, Any],
    decision: str,
) -> dict[str, Any]:
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
                "interruptId": card["approval_id"],
                "status": "resolved",
                "payload": {"decision": decision},
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
    finished = [value for value in events if value["type"] == "RUN_FINISHED"]
    assert finished, events[-1]
    return finished[-1]["outcome"]["interrupts"][0]["metadata"]["agent_framework"]["data"]


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(
        str(value.get("delta") or "") for value in events if value["type"] == "TEXT_MESSAGE_CONTENT"
    )


def _create_project_and_binding(client: TestClient) -> tuple[dict[str, Any], dict[str, Any]]:
    project_response = client.post(
        "/api/harness/projects",
        json={
            "command_id": "continuous-pi-project",
            "kind": "delivery",
            "title": "Chat",
            "goal": "让Chat开发自己",
            "status": "active",
        },
    )
    assert project_response.status_code == 201, project_response.text
    project = project_response.json()
    binding_response = client.post(
        f"/api/harness/projects/{project['id']}/repositories",
        json={
            "command_id": "continuous-pi-binding",
            "expected_project_row_version": project["row_version"],
            "alias": "primary",
            "display_name": "Chat",
            "role": "primary",
            "root_key": "code",
            "relative_path": "repo",
        },
    )
    assert binding_response.status_code == 201, binding_response.text
    return project, binding_response.json()


def _intent_response() -> str:
    return json.dumps(
        {
            "scenario": "continue_project",
            "goal": "检查Chat代码仓库",
            "confidence": 0.99,
            "project_hint": "Chat",
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["Chat", "代码库"],
            "reason_summary": "用户明确要求检查正式Chat Project的代码库",
        },
        ensure_ascii=False,
    )


def _summary_response() -> str:
    return json.dumps(
        {
            "topic": "Chat仓库只读检查",
            "confirmed_facts": ["README标题为Chat"],
            "decisions": [],
            "open_questions": [],
            "project_hint": "Chat",
            "work_state_candidates": [],
            "memory_candidates": [],
        },
        ensure_ascii=False,
    )


def _transport_responses(*, include_summary: bool) -> list[str]:
    values = [
        _intent_response(),
        "1. 读取仓库入口文档；2. 核对项目身份；3. 只报告有证据支持的结论。",
    ]
    if include_summary:
        values.append(_summary_response())
    return values


def _approve_intent_and_plan(
    client: TestClient,
    *,
    session_id: str,
    intent_card: Mapping[str, Any],
    prefix: str,
) -> dict[str, Any]:
    plan_card = _card(
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, f"{prefix}-intent", intent_card, "approve"),
            )
        )
    )
    assert plan_card["execution_context"]["agent_id"] == "task_planner"
    return _card(
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, f"{prefix}-plan", plan_card, "approve"),
            )
        )
    )


def test_continuous_workflow_runs_pi_readonly_in_one_product_run(tmp_path: Path) -> None:
    _repository(tmp_path / "repo")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(_transport_responses(include_summary=True))
    manager = FakeReadonlyPiManager(catalog.get("provider-a"), store)
    app = create_app(
        _settings(tmp_path),
        model_call_store=store,
        model_call_transport=transport,
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )

    with TestClient(app) as client:
        project, binding = _create_project_and_binding(client)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "continuous-pi-start",
                        "请检查Chat项目的代码库，先只读分析，不要修改。",
                    ),
                )
            )
        )
        assert intent_card["execution_context"]["agent_id"] == "intent_router"

        first_pi_card = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="continuous-pi",
        )
        assert first_pi_card["execution_context"]["executor_id"] == "pi_readonly_dispatch"
        assert first_pi_card["execution_context"]["call_position"] == 1
        assert first_pi_card["provider_request"]["store"] is False
        assert [tool["name"] for tool in first_pi_card["provider_request"]["tools"]] == [
            "read",
            "grep",
            "find",
            "ls",
        ]
        assert len(transport.prepared) == 2

        second_pi_events = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(
                    session_id,
                    "continuous-pi-first-call",
                    first_pi_card,
                    "approve",
                ),
            )
        )
        second_pi_card = _card(second_pi_events)
        assert second_pi_card["execution_context"]["executor_id"] == "pi_readonly_dispatch"
        assert second_pi_card["execution_context"]["call_position"] == 2
        assert manager.executions[0].tool_results[0]["result"]["lines"][0] == {
            "line": 1,
            "text": "# Chat",
        }

        summary_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "continuous-pi-second-call",
                        second_pi_card,
                        "approve",
                    ),
                )
            )
        )
        assert summary_card["execution_context"]["agent_id"] == "turn_summarizer"
        assert len(transport.prepared) == 2

        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(
                    session_id,
                    "continuous-pi-summary",
                    summary_card,
                    "approve",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        executions = client.get(f"/api/runs/{run['id']}/tool-executions").json()["tool_executions"]
        governance = client.get(f"/api/runs/{run['id']}/governance").json()
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert run["status"] == "succeeded"
    assert _text(completed) == "已只读检查README：仓库标题为 Chat。"
    assert messages[-1]["content"] == "已只读检查README：仓库标题为 Chat。"
    assert len(manager.executions) == 1
    assert manager.executions[0].closed is True
    assert len(manager.executions[0].calls) == 2
    assert len(transport.prepared) == 3
    assert [value.executor_id for value in transport.prepared] == [
        "intent_agent",
        "planning_agent",
        "turn_summary_agent",
    ]
    assert len(executions) == 1
    execution = executions[0]
    assert execution["run_id"] == run["id"]
    assert execution["status"] == "succeeded"
    assert execution["repository_binding_id"] == binding["binding"]["id"]
    assert execution["repository_snapshot_id"] == binding["snapshot"]["id"]
    assert execution["model_call_count"] == 2
    assert execution["internal_tool_call_count"] == 1
    assert execution["result"]["final_text"] == "已只读检查README：仓库标题为 Chat。"
    assert governance["execution_draft"]["payload"]["runtime_target"]["runtime"] == "pi"
    assert governance["run_spec"]["spec"]["runtime_agent"]["runtime"] == "pi"
    pi_model_calls = [
        value for value in governance["model_calls"] if value["workflow_node_id"] == "pi_readonly_dispatch"
    ]
    assert len(pi_model_calls) == 2
    assert [
        revision["attempts"][0]["status"] for call in pi_model_calls for revision in call["revisions"]
    ] == ["completed", "completed"]
    trace_nodes = {
        value["payload"]["executor_id"] for value in trace if value["event_type"] == "workflow.node.content"
    }
    assert {
        "execution_route",
        "pi_readonly_result_assembly",
        "turn_summary_agent",
        "result_finalization",
    } <= trace_nodes
    route_trace = next(
        value
        for value in trace
        if value["event_type"] == "workflow.node.content"
        and value["payload"]["executor_id"] == "execution_route"
    )
    route_decision = route_trace["payload"]["public_output"]["route_decision"]
    assert route_decision["selected_branch"] == "pi_readonly"
    assert route_decision["selected_target"] == "pi_readonly_dispatch"
    assert [value["selected"] for value in route_decision["options"]] == [False, True, False]
    assert project["id"] == governance["execution_draft"]["payload"]["project_work_binding"]["project_id"]


def test_pi_readonly_tool_policy_can_require_human_confirmation(tmp_path: Path) -> None:
    _repository(tmp_path / "repo")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    manager = FakeReadonlyPiManager(catalog.get("provider-a"), store)
    app = create_app(
        _settings(tmp_path),
        model_call_store=store,
        model_call_transport=SequencedTransport(_transport_responses(include_summary=True)),
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )

    with TestClient(app) as client:
        _create_project_and_binding(client)
        policy = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "tool_execution_authorization",
                        "mode": "require_human",
                        "reason": "验证pi内部只读Tool也可逐次确认",
                    }
                ],
            },
        )
        assert policy.status_code == 200, policy.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "pi-human-start", "检查Chat代码库"),
                )
            )
        )
        first_pi = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent,
            prefix="pi-human",
        )
        tool_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "pi-human-model", first_pi, "approve"),
                )
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        [waiting] = client.get(f"/api/runs/{run['id']}/tool-executions").json()["tool_executions"]

        assert tool_card["review_kind"] == "tool_execution"
        assert tool_card["tool_name"] == "read"
        assert tool_card["arguments"] == {"path": "README.md"}
        assert waiting["status"] == "waiting_human"

        second_pi = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(session_id, "pi-human-tool", tool_card, "approve"),
                )
            )
        )
        assert second_pi["execution_context"]["call_position"] == 2
        assert manager.executions[0].tool_results[0]["result"]["lines"][0]["text"] == "# Chat"


def test_repository_change_stops_pi_before_process_dispatch(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "repo")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    manager = FakeReadonlyPiManager(catalog.get("provider-a"), store)
    transport = SequencedTransport(_transport_responses(include_summary=False))
    app = create_app(
        _settings(tmp_path),
        model_call_store=store,
        model_call_transport=transport,
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )

    with TestClient(app) as client:
        _, binding = _create_project_and_binding(client)
        policy = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "execution_authorization",
                        "mode": "require_human",
                        "reason": "在pi dispatch之前检查Repository Snapshot新鲜度",
                    }
                ],
            },
        )
        assert policy.status_code == 200, policy.text
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "pi-stale-start", "检查Chat代码库"),
                )
            )
        )
        execution_card = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent,
            prefix="pi-stale",
        )
        assert execution_card["decision_point_key"] == "execution_authorization"

        (repository / "changed.py").write_text("print('changed')\n", encoding="utf-8")
        refreshed = client.post(
            f"/api/harness/repositories/{binding['binding']['id']}/refresh",
            json={
                "command_id": "continuous-pi-stale-refresh",
                "expected_binding_row_version": binding["binding"]["row_version"],
            },
        )
        assert refreshed.status_code == 200, refreshed.text

        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(
                    session_id,
                    "pi-stale-execution",
                    execution_card,
                    "execute",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        executions = client.get(f"/api/runs/{run['id']}/tool-executions").json()["tool_executions"]

    assert run["status"] == "failed"
    assert run["failure_code"] == "repository_snapshot_stale"
    assert manager.executions == []
    assert executions == []


def test_pi_tool_outside_runspec_capability_fails_closed(tmp_path: Path) -> None:
    _repository(tmp_path / "repo")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    manager = FakeReadonlyPiManager(
        catalog.get("provider-a"),
        store,
        requested_tool="bash",
    )
    app = create_app(
        _settings(tmp_path),
        model_call_store=store,
        model_call_transport=SequencedTransport(_transport_responses(include_summary=False)),
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )

    with TestClient(app) as client:
        _create_project_and_binding(client)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "pi-deny-start", "检查Chat代码库"),
                )
            )
        )
        first_pi = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent,
            prefix="pi-deny",
        )
        _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "pi-deny-model", first_pi, "approve"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        [execution] = client.get(f"/api/runs/{run['id']}/tool-executions").json()["tool_executions"]

    assert run["status"] == "failed"
    assert run["failure_code"] == "PI_TOOL_NOT_ALLOWED"
    assert execution["status"] == "failed"
    assert execution["failure_code"] == "PI_TOOL_NOT_ALLOWED"
    assert manager.executions[0].tool_results == []


def test_abandoning_pi_model_call_abandons_same_product_run(tmp_path: Path) -> None:
    _repository(tmp_path / "repo")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    manager = FakeReadonlyPiManager(catalog.get("provider-a"), store)
    app = create_app(
        _settings(tmp_path),
        model_call_store=store,
        model_call_transport=SequencedTransport(_transport_responses(include_summary=False)),
        pi_runtime_manager=manager,  # type: ignore[arg-type]
    )

    with TestClient(app) as client:
        _create_project_and_binding(client)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(session_id, "pi-abandon-start", "检查Chat代码库"),
                )
            )
        )
        first_pi = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent,
            prefix="pi-abandon",
        )
        abandoned_events = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(session_id, "pi-abandon-call", first_pi, "abandon"),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        [execution] = client.get(f"/api/runs/{run['id']}/tool-executions").json()["tool_executions"]
        messages = client.get(f"/api/sessions/{session_id}/messages").json()["messages"]

    assert abandoned_events[-1]["type"] == "RUN_FINISHED"
    assert run["status"] == "abandoned"
    assert execution["status"] == "abandoned"
    assert execution["failure_code"] == "user_abandoned"
    assert manager.executions[0].closed is True
    # The abandoned user message remains an audit fact but is withdrawn from
    # context-visible history; the frontend restores origin_prompt as an input
    # draft instead of committing it as conversation history.
    assert messages == []

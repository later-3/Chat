"""SD3 vertical tests for governed pi exact edits in a managed worktree."""

from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.execution_workspaces import ExecutionWorkspaceService
from backend.app.main import create_app
from backend.app.model_call_review import InMemoryModelCallReviewStore
from backend.app.model_providers import ModelProviderConfig
from backend.app.pi_runtime import (
    PiCompletedBoundary,
    PiGatewayCall,
    PiGatewayDecision,
    PiModelCallBoundary,
    PiToolCallBoundary,
)
from backend.app.readonly_tools import ReadonlyToolService
from backend.app.tool_configs import PiToolConfigSnapshot
from backend.app.tool_execution import ToolOperationService
from backend.tests.test_continuous_pi_readonly import (
    SequencedTransport,
    _approve_intent_and_plan,
    _card,
    _catalog,
    _create_project_and_binding,
    _events,
    _git,
    _intent_response,
    _repository,
    _request,
    _resume,
    _settings,
    _summary_response,
    _text,
)


class FakeWorkspacePiExecution:
    """Emit real model/tool boundaries while Chat performs the actual edit."""

    def __init__(
        self,
        *,
        provider: ModelProviderConfig,
        config: PiToolConfigSnapshot,
        store: InMemoryModelCallReviewStore,
        workspace_id: str,
        tool_execution_id: str,
        workspaces: ExecutionWorkspaceService,
        readonly_tools: ReadonlyToolService,
        operations: ToolOperationService,
    ) -> None:
        self.provider = provider
        self.config = config
        self.store = store
        self.workspace_id = workspace_id
        self.tool_execution_id = tool_execution_id
        self.workspaces = workspaces
        self.readonly_tools = readonly_tools
        self.operations = operations
        self.model_call_count = 0
        self.step = 0
        self.calls: list[PiGatewayCall] = []
        self.tool_results: list[dict[str, Any]] = []
        self.closed = False

    def _model_boundary(self, *, after_tools: bool = False) -> PiModelCallBoundary:
        self.model_call_count += 1
        request: dict[str, Any] = {
            "model": self.config.model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "把README标题从Chat精确修改为Chat Workspace。",
                        }
                    ],
                }
            ],
            "tools": [
                {
                    "type": "function",
                    "name": name,
                    "description": f"Chat-owned {name}",
                    "parameters": {
                        "type": "object",
                        "properties": (
                            {
                                "path": {"type": "string"},
                                "old_text": {"type": "string"},
                                "new_text": {"type": "string"},
                            }
                            if name == "edit"
                            else {"path": {"type": "string"}}
                        ),
                        "required": (["path", "old_text", "new_text"] if name == "edit" else ["path"]),
                        "additionalProperties": False,
                    },
                    "strict": False,
                }
                for name in self.config.allowed_tools
            ],
            "store": False,
            "stream": True,
        }
        if after_tools:
            request["input"].append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "Chat已执行获批edit，请基于Tool结果汇报。",
                        }
                    ],
                }
            )
        call = PiGatewayCall(
            id=f"workspace-model-{self.model_call_count}",
            protocol=self.provider.protocol,
            body=json.dumps(request, separators=(",", ":")).encode(),
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
                rpc_request_id="rpc-read-workspace",
                tool_call_id="tool-read-workspace",
                tool_name="read",
                arguments={"path": "README.md"},
            )
        if self.step == 3:
            return PiToolCallBoundary(
                kind="tool_call",
                rpc_request_id="rpc-edit-workspace",
                tool_call_id="tool-edit-workspace",
                tool_name="edit",
                arguments={
                    "path": "README.md",
                    "old_text": "# Chat",
                    "new_text": "# Chat Workspace",
                },
            )
        if self.step == 4:
            return self._model_boundary(after_tools=True)
        return PiCompletedBoundary(
            kind="completed",
            text="已在隔离工作区把README标题精确修改为 Chat Workspace；尚未提交或推送。",
            metrics=self.metrics(),
        )

    async def approve_tool_call(
        self,
        boundary: PiToolCallBoundary,
        arguments: Mapping[str, Any],
    ) -> None:
        if boundary.tool_name == "edit":
            result = await self.operations.execute_exact_edit(
                tool_execution_id=self.tool_execution_id,
                provider_tool_call_id=boundary.tool_call_id,
                arguments=arguments,
                worker_id="fake-pi-workspace-gateway",
            )
        else:
            root = await self.workspaces.private_path(self.workspace_id)
            result = await self.readonly_tools.execute_at_root(
                root=root,
                tool_name=boundary.tool_name,
                arguments=arguments,
                source_identity={"execution_workspace_id": self.workspace_id},
            )
        self.tool_results.append(result)

    async def reject_tool_call(self, _: PiToolCallBoundary) -> None:
        return

    def metrics(self) -> dict[str, Any]:
        return {
            "model_call_count": self.model_call_count,
            "internal_tool_call_count": min(max(self.step - 1, 0), 2),
            "input_tokens": 180,
            "output_tokens": 52,
            "duration_ms": 2400,
            "tool_calls": [
                {
                    "tool_call_id": "tool-read-workspace",
                    "tool_name": "read",
                    "status": "completed" if self.tool_results else "requested",
                },
                {
                    "tool_call_id": "tool-edit-workspace",
                    "tool_name": "edit",
                    "status": "completed" if len(self.tool_results) > 1 else "requested",
                },
            ],
        }

    async def close(self) -> None:
        self.closed = True


class FakeWorkspacePiManager:
    def __init__(
        self,
        provider: ModelProviderConfig,
        store: InMemoryModelCallReviewStore,
    ) -> None:
        self.provider = provider
        self.store = store
        self.executions: list[FakeWorkspacePiExecution] = []

    async def start(
        self,
        task: str,
        config: PiToolConfigSnapshot,
        *,
        repository_fence=None,
        readonly_tools: ReadonlyToolService | None = None,
        workspace_id: str | None = None,
        tool_execution_id: str | None = None,
        execution_workspaces: ExecutionWorkspaceService | None = None,
        tool_operations: ToolOperationService | None = None,
    ) -> FakeWorkspacePiExecution:
        assert task
        assert repository_fence is None
        assert readonly_tools is not None
        assert workspace_id and tool_execution_id
        assert execution_workspaces is not None and tool_operations is not None
        assert config.allowed_tools == ("read", "grep", "find", "ls", "edit")
        execution = FakeWorkspacePiExecution(
            provider=self.provider,
            config=config,
            store=self.store,
            workspace_id=workspace_id,
            tool_execution_id=tool_execution_id,
            workspaces=execution_workspaces,
            readonly_tools=readonly_tools,
            operations=tool_operations,
        )
        self.executions.append(execution)
        return execution

    async def close_all(self) -> None:
        for execution in self.executions:
            await execution.close()


def _workspace_transport_responses() -> list[str]:
    intent = json.dumps(
        {
            "scenario": "continue_project",
            "goal": "修改Chat项目README标题",
            "confidence": 0.99,
            "project_hint": "Chat",
            "needs_plan": False,
            "needs_clarification": False,
            "clarification_question": None,
            "context_keywords": ["Chat", "README", "修改代码"],
            "reason_summary": "用户明确要求在Chat项目中实现一次代码文件修改",
        },
        ensure_ascii=False,
    )
    return [
        intent,
        "1. 读取README；2. 精确编辑唯一标题；3. 核验隔离工作区变化；4. 不提交、不推送。",
        _summary_response(),
    ]


def test_continuous_workflow_governs_exact_edit_in_isolated_workspace(
    tmp_path: Path,
) -> None:
    repository = tmp_path / "repo"
    repository.mkdir(parents=True)
    _git(repository, "init", "-q")
    _git(repository, "config", "user.name", "Chat Test")
    _git(repository, "config", "user.email", "chat-test@example.invalid")
    _git(repository, "config", "commit.gpgsign", "false")
    (repository / "README.md").write_text(
        "# Chat\n\nSelf development repository.\n",
        encoding="utf-8",
    )
    _git(repository, "add", "README.md")
    _git(repository, "commit", "-qm", "initial")
    source_head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repository,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()

    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(_workspace_transport_responses())
    provider = catalog.get("provider-a")
    assert provider is not None
    manager = FakeWorkspacePiManager(provider, store)
    settings = _settings(tmp_path)
    settings = replace(
        settings,
        execution_workspace_root=tmp_path / "managed-workspaces",
    )
    app = create_app(
        settings,
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
                        "workspace-start",
                        "请在Chat项目中实现功能：修改代码，把README标题从Chat改成Chat Workspace。",
                    ),
                )
            )
        )
        first_model = _approve_intent_and_plan(
            client,
            session_id=session_id,
            intent_card=intent_card,
            prefix="workspace",
        )
        assert first_model["execution_context"]["executor_id"] == "pi_workspace_dispatch"

        edit_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "workspace-model-one",
                        first_model,
                        "approve",
                    ),
                )
            )
        )
        assert edit_card["review_kind"] == "tool_execution"
        assert edit_card["tool_name"] == "edit"
        operation_card = edit_card["tool_operation"]
        assert operation_card["target_path"] == "README.md"
        assert "-# Chat" in operation_card["diff_preview"]
        assert "+# Chat Workspace" in operation_card["diff_preview"]

        second_model = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "workspace-edit",
                        edit_card,
                        "approve",
                    ),
                )
            )
        )
        assert second_model["execution_context"]["executor_id"] == "pi_workspace_dispatch"

        summary_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "workspace-model-two",
                        second_model,
                        "approve",
                    ),
                )
            )
        )
        completed = _events(
            client.post(
                "/api/workflows/continuous-collaboration/run",
                json=_resume(
                    session_id,
                    "workspace-summary",
                    summary_card,
                    "approve",
                ),
            )
        )
        [run] = client.get(f"/api/sessions/{session_id}/runs").json()["runs"]
        [execution] = client.get(f"/api/runs/{run['id']}/tool-executions").json()["tool_executions"]
        trace = client.get(f"/api/sessions/{session_id}/runs/{run['id']}/trace").json()["trace"]

    assert run["status"] == "succeeded"
    assert "尚未提交或推送" in _text(completed)
    assert (repository / "README.md").read_text(encoding="utf-8").startswith("# Chat\n")
    assert (
        subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repository,
            check=True,
            text=True,
            capture_output=True,
        ).stdout.strip()
        == source_head
    )
    assert execution["mode"] == "workspace_edit"
    assert execution["status"] == "succeeded"
    assert execution["workspace"]["status"] == "retained"
    assert execution["workspace"]["changed_paths"] == ["README.md"]
    [operation] = execution["operations"]
    assert operation["status"] == "succeeded"
    assert operation["authorization_consumption_id"]
    assert operation["attempts"][0]["status"] == "succeeded"
    assert operation["expected_postimage_hash"] == operation["observed_hash"]
    assert operation["result"]["changed"] is True
    assert project["id"]
    assert binding["snapshot"]["id"] == execution["repository_snapshot_id"]
    trace_nodes = {
        value["payload"]["executor_id"] for value in trace if value["event_type"] == "workflow.node.content"
    }
    assert {
        "execution_route",
        "execution_workspace_prepare",
        "pi_workspace_result_assembly",
        "result_finalization",
    } <= trace_nodes


def test_completed_model_call_does_not_block_next_agent_after_product_decision(
    tmp_path: Path,
) -> None:
    """A Product HITL checkpoint between two Agents must not revive old review state."""

    _repository(tmp_path / "repo")
    catalog = _catalog()
    store = InMemoryModelCallReviewStore(catalog)
    transport = SequencedTransport(
        [
            _intent_response(),
            "1. 读取README；2. 精确修改标题；3. 验证只改变目标文件。",
        ]
    )
    app = create_app(
        _settings(tmp_path),
        model_call_store=store,
        model_call_transport=transport,
    )

    with TestClient(app) as client:
        policy = client.post(
            "/api/hitl/policy-sets/activate",
            json={
                "scope_kind": "principal",
                "scope_ref_id": "local-user",
                "rules": [
                    {
                        "decision_point_key": "project_work_binding",
                        "mode": "require_human",
                        "reason": "验证ModelCall与Product HITL交错恢复",
                    }
                ],
            },
        )
        assert policy.status_code == 200, policy.text
        _create_project_and_binding(client)
        session_id = client.post("/api/sessions", json={}).json()["id"]
        intent_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_request(
                        session_id,
                        "interleaved-hitl-start",
                        "请在Chat项目中修改README标题。",
                    ),
                )
            )
        )
        project_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "interleaved-hitl-intent",
                        intent_card,
                        "approve",
                    ),
                )
            )
        )
        assert project_card["decision_point_key"] == "project_work_binding"

        plan_card = _card(
            _events(
                client.post(
                    "/api/workflows/continuous-collaboration/run",
                    json=_resume(
                        session_id,
                        "interleaved-hitl-project",
                        project_card,
                        "accept",
                    ),
                )
            )
        )

    assert plan_card["review_kind"] == "model_call"
    assert plan_card["execution_context"]["agent_id"] == "task_planner"
    current = store.current_for_thread(session_id)
    assert current is not None
    assert current.draft_id == plan_card["draft_id"]
    assert current.status == "pending_approval"

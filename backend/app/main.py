"""FastAPI composition root for the independent Chat product."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from agent_framework.ag_ui import add_agent_framework_fastapi_endpoint
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from .agent_profiles import (
    AgentProfileConflict,
    AgentProfileError,
    AgentProfileNotFound,
    AgentProfileService,
)
from .agents import create_agent
from .config import Settings
from .governance import ExecutionGovernanceService, GovernanceConflict, GovernanceValidationError
from .model_call_review import (
    ExactProviderTransport,
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    ModelCallDraftValidationError,
    ProviderDispatchError,
    RoutedProviderTransport,
    provider_endpoint,
)
from .model_call_workflow import ProviderTransport, create_model_call_workflow
from .product_sessions import ProductDatabase, ProductSessionService
from .product_sessions.agui import ProductAwareAgentFrameworkAgent
from .product_sessions.service import (
    ProductSessionConflict,
    ProductSessionNotFound,
)
from .pi_runtime import PiRuntimeManager
from .tool_configs import (
    ToolConfigurationConflict,
    ToolConfigurationError,
    ToolConfigurationNotFound,
    ToolConfigurationService,
)
from .workflows import (
    CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
    CONTINUOUS_COLLABORATION_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    GOVERNED_IDIOM_CHAIN_WORKFLOW,
    GOVERNED_PI_AGENT_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
    ProductAwareWorkflow,
    create_continuous_collaboration_workflow,
    create_governed_agent_handoff_workflow,
    create_governed_idiom_chain_workflow,
    create_governed_pi_agent_workflow,
    create_nested_quality_workflow,
    workflow_catalog_view,
)


class ReviseModelCallDraftRequest(BaseModel):
    """Replace every editable field in one provider request draft."""

    model_config = ConfigDict(extra="forbid")

    expected_hash: str
    provider_id: str
    provider_request: dict[str, Any]


class CreateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = "新会话"
    model_provider_id: str | None = None
    model: str | None = None


class UpdateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    archived: bool | None = None
    model_provider_id: str | None = None
    model: str | None = None


class UpdateAgentProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int
    name: str
    description: str
    instructions: str
    provider_id: str
    model: str
    enabled: bool


class UpdatePiToolConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int
    enabled: bool
    provider_id: str
    model: str
    working_directory: str
    allowed_tools: list[str]
    thinking_level: str
    max_model_calls: int
    timeout_seconds: int
    system_prompt: str


class HitlPolicyRuleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_point_key: str
    mode: str
    condition: dict[str, Any] | None = None
    on_match: str | None = None
    constraints: dict[str, Any] = Field(default_factory=dict)
    reason: str = ""


class ActivateHitlPolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope_kind: str
    scope_ref_id: str
    scope_ref_revision: str | None = None
    expected_active_revision_id: str | None = None
    change_summary: str = ""
    rules: list[HitlPolicyRuleRequest]


class PreviewHitlPolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision_point_key: str
    scopes: list[dict[str, str]]
    facts: dict[str, Any] = Field(default_factory=dict)


class HumanDecisionItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_key: str
    decision: str


class ResolveHumanDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_request_hash: str
    expected_row_version: int
    item_decisions: list[HumanDecisionItemRequest]


def create_app(
    settings: Settings | None = None,
    *,
    model_call_store: InMemoryModelCallReviewStore | None = None,
    model_call_transport: ProviderTransport | None = None,
    product_session_service: ProductSessionService | None = None,
    pi_runtime_manager: PiRuntimeManager | None = None,
) -> FastAPI:
    """Create an isolated app instance suitable for production or contract tests."""

    resolved = settings or Settings.from_file()
    model_catalog = resolved.model_catalog()
    product_sessions = product_session_service or ProductSessionService(
        ProductDatabase(resolved.database_url)
    )
    agent_profiles = AgentProfileService(product_sessions.database, model_catalog)
    review_store = model_call_store or InMemoryModelCallReviewStore(model_catalog)
    tool_configurations = ToolConfigurationService(
        product_sessions.database,
        model_catalog,
        resolved.pi_runtime,
    )
    governance = ExecutionGovernanceService(product_sessions.database)
    pi_runtime = pi_runtime_manager or (
        PiRuntimeManager(
            runtime=resolved.pi_runtime,
            catalog=model_catalog,
            review_store=review_store,
        )
        if model_catalog is not None
        else None
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await product_sessions.initialize()
        await governance.initialize()
        await agent_profiles.initialize()
        await tool_configurations.initialize()
        try:
            yield
        finally:
            if pi_runtime is not None:
                await pi_runtime.close_all()
            await product_sessions.database.close()

    app = FastAPI(
        title="Chat",
        version="0.1.0",
        description="Independent AI collaboration Chat product powered by MAF and AG-UI.",
        lifespan=lifespan,
    )
    app.state.settings = resolved
    app.state.model_call_review_store = review_store
    app.state.product_sessions = product_sessions
    app.state.agent_profiles = agent_profiles
    app.state.tool_configurations = tool_configurations
    app.state.governance = governance
    app.state.pi_runtime = pi_runtime
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.frontend_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "chat",
            "version": "0.1.0",
            "agent_framework": "microsoft-agent-framework",
            "protocol": "ag-ui",
            "runtime_mode": resolved.runtime_mode,
            "model": resolved.model if resolved.runtime_mode == "model" else None,
            "model_call_approval": "every_call" if resolved.runtime_mode == "model" else "not_applicable",
            "product_sessions": "sqlite",
            "pi_agent": resolved.pi_runtime.public_view(),
        }

    def validate_model_selection(provider_id: str | None, model: str | None) -> tuple[str | None, str | None]:
        if provider_id is None and model is None:
            if model_catalog is None:
                return None, None
            return model_catalog.default_provider_id, model_catalog.default_model
        if provider_id is None or model is None:
            raise HTTPException(status_code=422, detail="Provider和模型必须同时提供")
        if model_catalog is None:
            raise HTTPException(status_code=422, detail="当前没有可配置的模型Provider")
        try:
            model_catalog.require_selection(provider_id, model)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return provider_id, model

    @app.post("/api/sessions", status_code=201)
    async def create_session(command: CreateSessionRequest) -> dict[str, Any]:
        provider_id, model = validate_model_selection(command.model_provider_id, command.model)
        return await product_sessions.create_session(
            title=command.title,
            provider_id=provider_id,
            model=model,
        )

    @app.get("/api/sessions")
    async def list_sessions(include_archived: bool = False) -> dict[str, Any]:
        values = await product_sessions.list_sessions(include_archived=include_archived)
        return {"sessions": values}

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str) -> dict[str, Any]:
        try:
            return await product_sessions.get_session(session_id)
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.patch("/api/sessions/{session_id}")
    async def update_session(session_id: str, command: UpdateSessionRequest) -> dict[str, Any]:
        update_model = bool({"model_provider_id", "model"} & command.model_fields_set)
        provider_id = command.model_provider_id
        model = command.model
        if update_model:
            provider_id, model = validate_model_selection(provider_id, model)
        try:
            return await product_sessions.update_session(
                session_id,
                title=command.title,
                archived=command.archived,
                provider_id=provider_id,
                model=model,
                update_model=update_model,
            )
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ProductSessionConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/api/sessions/{session_id}/messages")
    async def session_messages(session_id: str) -> dict[str, Any]:
        try:
            return {"messages": await product_sessions.list_messages(session_id)}
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/api/sessions/{session_id}/runs")
    async def session_runs(session_id: str) -> dict[str, Any]:
        try:
            return {"runs": await product_sessions.list_runs(session_id)}
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post("/api/sessions/{session_id}/agui-runs/{agui_run_id}/cancel")
    async def cancel_session_run(session_id: str, agui_run_id: str) -> dict[str, Any]:
        try:
            return await product_sessions.cancel_protocol_run(session_id, agui_run_id)
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ProductSessionConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/api/sessions/{session_id}/runs/{run_id}/trace")
    async def run_trace(session_id: str, run_id: str) -> dict[str, Any]:
        try:
            return {"trace": await product_sessions.list_trace(session_id, run_id)}
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/api/sessions/{session_id}/workflows/{workflow_id}/latest-trace")
    async def latest_workflow_trace(session_id: str, workflow_id: str) -> dict[str, Any]:
        try:
            return {
                "trace": await product_sessions.latest_workflow_trace(
                    session_id, workflow_id
                )
            }
        except ProductSessionNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.get("/api/workflows")
    async def workflows() -> dict[str, Any]:
        definitions = [NESTED_QUALITY_WORKFLOW]
        if model_catalog is not None:
            definitions.extend(
                (
                    CONTINUOUS_COLLABORATION_WORKFLOW,
                    CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
                    GOVERNED_AGENT_HANDOFF_WORKFLOW,
                    GOVERNED_IDIOM_CHAIN_WORKFLOW,
                )
            )
        if model_catalog is not None and resolved.pi_runtime.available:
            definitions.append(GOVERNED_PI_AGENT_WORKFLOW)
        return {"workflows": workflow_catalog_view(tuple(definitions))}

    @app.get("/api/hitl/decision-points")
    async def hitl_decision_points() -> dict[str, Any]:
        return {"decision_points": await governance.decision_points()}

    @app.get("/api/hitl/policy-sets")
    async def hitl_policy_sets() -> dict[str, Any]:
        return {"policy_sets": await governance.policy_sets()}

    @app.post("/api/hitl/policy-sets/activate")
    async def activate_hitl_policy(command: ActivateHitlPolicyRequest) -> dict[str, Any]:
        try:
            return await governance.activate_policy(
                scope_kind=command.scope_kind,
                scope_ref_id=command.scope_ref_id,
                scope_ref_revision=command.scope_ref_revision,
                rules=[value.model_dump() for value in command.rules],
                expected_active_revision_id=command.expected_active_revision_id,
                change_summary=command.change_summary,
            )
        except GovernanceConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except GovernanceValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/api/hitl/policy-preview")
    async def preview_hitl_policy(command: PreviewHitlPolicyRequest) -> dict[str, Any]:
        try:
            return await governance.preview(
                decision_point_key=command.decision_point_key,
                scopes=command.scopes,
                facts=command.facts,
            )
        except GovernanceValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/runs/{run_id}/governance")
    async def run_governance(run_id: str) -> dict[str, Any]:
        try:
            return await governance.governance_for_run(run_id)
        except GovernanceValidationError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @app.post("/api/hitl/decision-requests/{request_id}/resolve")
    async def resolve_hitl_request(
        request_id: str,
        command: ResolveHumanDecisionRequest,
    ) -> dict[str, Any]:
        try:
            decisions = await governance.resolve_human_request(
                request_id=request_id,
                expected_request_hash=command.expected_request_hash,
                expected_row_version=command.expected_row_version,
                decisions=[value.model_dump() for value in command.item_decisions],
            )
            return {"decision_request_id": request_id, "status": "decision_recorded", "decisions": decisions}
        except GovernanceConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except GovernanceValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/tools")
    async def tools() -> dict[str, Any]:
        return {"tools": await tool_configurations.list()}

    @app.get("/api/tools/pi_agent/executions")
    async def pi_tool_executions(limit: int = 20) -> dict[str, Any]:
        return {"executions": await tool_configurations.executions(limit)}

    @app.put("/api/tools/pi_agent")
    async def update_pi_tool(command: UpdatePiToolConfigurationRequest) -> dict[str, Any]:
        try:
            return await tool_configurations.update(**command.model_dump())
        except ToolConfigurationNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ToolConfigurationConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ToolConfigurationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    async def pi_provider_gateway(
        request: Request,
        authorization: str | None,
        protocol: str,
    ):
        if pi_runtime is None:
            raise HTTPException(status_code=503, detail="pi Provider审批网关不可用")
        try:
            return await pi_runtime.gateway_response(
                authorization=authorization,
                protocol=protocol,
                body=await request.body(),
            )
        except ProviderDispatchError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.post("/api/pi-provider/v1/chat/completions", include_in_schema=False)
    async def pi_chat_completions_gateway(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        return await pi_provider_gateway(request, authorization, "openai_chat_completions")

    @app.post("/api/pi-provider/v1/responses", include_in_schema=False)
    async def pi_responses_gateway(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        return await pi_provider_gateway(request, authorization, "openai_responses")

    @app.get("/api/agents")
    async def agents() -> dict[str, Any]:
        return {"agents": await agent_profiles.list()}

    @app.put("/api/agents/{agent_id}")
    async def update_agent_profile(
        agent_id: str,
        command: UpdateAgentProfileRequest,
    ) -> dict[str, Any]:
        try:
            return await agent_profiles.update(
                agent_id,
                expected_revision=command.expected_revision,
                name=command.name,
                description=command.description,
                instructions=command.instructions,
                provider_id=command.provider_id,
                model=command.model,
                enabled=command.enabled,
            )
        except AgentProfileNotFound as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except AgentProfileConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except AgentProfileError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/model-call-drafts/{draft_id}")
    async def get_model_call_draft(draft_id: str) -> dict[str, Any]:
        try:
            return review_store.review_card(draft_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail="模型调用草稿不存在") from error

    @app.get("/api/model-providers")
    async def model_providers() -> dict[str, Any]:
        if model_catalog is None:
            return {"default_provider_id": None, "default_model": None, "providers": []}
        return {
            "default_provider_id": model_catalog.default_provider_id,
            "default_model": model_catalog.default_model,
            "providers": model_catalog.public_view(),
        }

    @app.put("/api/model-call-drafts/{draft_id}")
    async def revise_model_call_draft(
        draft_id: str,
        command: ReviseModelCallDraftRequest,
    ) -> dict[str, Any]:
        try:
            revised = review_store.revise(
                draft_id=draft_id,
                expected_hash=command.expected_hash,
                provider_id=command.provider_id,
                provider_request=command.provider_request,
            )
        except LookupError as error:
            raise HTTPException(status_code=404, detail="模型调用草稿不存在") from error
        except ModelCallDraftConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except ModelCallDraftValidationError as error:
            raise HTTPException(
                status_code=422,
                detail={"message": "模型调用请求未通过校验", "issues": list(error.issues)},
            ) from error
        return revised.review_card()

    if resolved.runtime_mode == "model":
        assert model_catalog is not None
        transport = model_call_transport or RoutedProviderTransport(
            transports={
                provider.id: ExactProviderTransport(
                    endpoint=provider_endpoint(provider.base_url, provider.protocol),
                    api_key=provider.api_key,
                )
                for provider in model_catalog.providers
                if provider.configured
            }
        )
        runner = create_model_call_workflow(
            provider_id=model_catalog.default_provider_id,
            model=resolved.model,
            store=review_store,
            transport=transport,
            sessions=product_sessions,
        )
    else:
        runner = ProductAwareAgentFrameworkAgent(
            create_agent(resolved),
            sessions=product_sessions,
        )
    app.state.agent = runner
    # MAF owns the Agent-to-AG-UI event conversion. Keeping that bridge here
    # avoids a second application-specific streaming protocol or state source.
    add_agent_framework_fastapi_endpoint(
        app,
        runner,
        "/api/agent",
        allow_origins=list(resolved.frontend_origins),
        tags=["agent"],
    )
    visible_workflow = ProductAwareWorkflow(
        workflow_factory=lambda _: create_nested_quality_workflow(),
        sessions=product_sessions,
        definition=NESTED_QUALITY_WORKFLOW,
    )
    app.state.visible_workflow = visible_workflow
    add_agent_framework_fastapi_endpoint(
        app,
        visible_workflow,
        NESTED_QUALITY_WORKFLOW.endpoint,
        allow_origins=list(resolved.frontend_origins),
        tags=["workflows"],
    )
    if resolved.runtime_mode == "model":
        continuous_run_ids: dict[str, str] = {}

        def continuous_factory(thread_id: str):
            return create_continuous_collaboration_workflow(
                thread_id=thread_id,
                run_id=lambda: continuous_run_ids.get(thread_id, "unknown"),
                profiles={
                    key: agent_profiles.runtime_snapshot(key)
                    for key in (
                        "intent_router",
                        "task_planner",
                        "response_agent",
                        "turn_summarizer",
                    )
                },
                store=review_store,
                transport=transport,
                sessions=product_sessions,
                governance=governance,
            )

        continuous_workflow = ProductAwareWorkflow(
            workflow_factory=continuous_factory,
            sessions=product_sessions,
            definition=CONTINUOUS_COLLABORATION_WORKFLOW,
            run_ids=continuous_run_ids,
        )
        app.state.continuous_workflow = continuous_workflow
        add_agent_framework_fastapi_endpoint(
            app,
            continuous_workflow,
            CONTINUOUS_COLLABORATION_WORKFLOW.endpoint,
            allow_origins=list(resolved.frontend_origins),
            tags=["workflows"],
        )
        handoff_run_ids: dict[str, str] = {}

        def handoff_factory(thread_id: str):
            return create_governed_agent_handoff_workflow(
                thread_id=thread_id,
                run_id=lambda: handoff_run_ids.get(thread_id, "unknown"),
                planner=agent_profiles.runtime_snapshot("planner"),
                reviewer=agent_profiles.runtime_snapshot("reviewer"),
                store=review_store,
                transport=transport,
                sessions=product_sessions,
            )

        handoff_workflow = ProductAwareWorkflow(
            workflow_factory=handoff_factory,
            sessions=product_sessions,
            definition=GOVERNED_AGENT_HANDOFF_WORKFLOW,
            run_ids=handoff_run_ids,
        )
        app.state.handoff_workflow = handoff_workflow
        add_agent_framework_fastapi_endpoint(
            app,
            handoff_workflow,
            GOVERNED_AGENT_HANDOFF_WORKFLOW.endpoint,
            allow_origins=list(resolved.frontend_origins),
            tags=["workflows"],
        )
        idiom_run_ids: dict[str, str] = {}

        def idiom_factory(thread_id: str):
            return create_governed_idiom_chain_workflow(
                thread_id=thread_id,
                run_id=lambda: idiom_run_ids.get(thread_id, "unknown"),
                agent_a=agent_profiles.runtime_snapshot("idiom_agent_a"),
                agent_b=agent_profiles.runtime_snapshot("idiom_agent_b"),
                store=review_store,
                transport=transport,
                sessions=product_sessions,
            )

        idiom_workflow = ProductAwareWorkflow(
            workflow_factory=idiom_factory,
            sessions=product_sessions,
            definition=GOVERNED_IDIOM_CHAIN_WORKFLOW,
            run_ids=idiom_run_ids,
        )
        app.state.idiom_workflow = idiom_workflow
        add_agent_framework_fastapi_endpoint(
            app,
            idiom_workflow,
            GOVERNED_IDIOM_CHAIN_WORKFLOW.endpoint,
            allow_origins=list(resolved.frontend_origins),
            tags=["workflows"],
        )
        if resolved.pi_runtime.available and pi_runtime is not None:
            pi_run_ids: dict[str, str] = {}

            def pi_factory(thread_id: str):
                return create_governed_pi_agent_workflow(
                    thread_id=thread_id,
                    run_id=lambda: pi_run_ids.get(thread_id, "unknown"),
                    config=tool_configurations.runtime_snapshot(),
                    manager=pi_runtime,
                    store=review_store,
                    sessions=product_sessions,
                    tools=tool_configurations,
                )

            pi_workflow = ProductAwareWorkflow(
                workflow_factory=pi_factory,
                sessions=product_sessions,
                definition=GOVERNED_PI_AGENT_WORKFLOW,
                run_ids=pi_run_ids,
            )
            app.state.pi_workflow = pi_workflow
            add_agent_framework_fastapi_endpoint(
                app,
                pi_workflow,
                GOVERNED_PI_AGENT_WORKFLOW.endpoint,
                allow_origins=list(resolved.frontend_origins),
                tags=["workflows"],
            )
    return app


app = create_app()

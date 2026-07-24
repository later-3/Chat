"""REST adapter for product resources and configuration surfaces."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from ..agent_profiles import (
    AgentProfileConflict,
    AgentProfileError,
    AgentProfileNotFound,
    AgentProfileService,
)
from ..config import ModelProviderCatalog, Settings
from ..governance import (
    ExecutionGovernanceService,
    GovernanceConflict,
    GovernanceValidationError,
)
from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    ModelCallDraftValidationError,
    ProviderDispatchError,
)
from ..pi_gateway import PiRuntimeManager
from ..pi_runtime import PiRuntimeError
from ..product_sessions import ProductSessionService
from ..product_sessions.service import ProductSessionConflict, ProductSessionNotFound
from ..runtime_execution import RuntimeExecutionService
from ..tool_configs import (
    ToolConfigurationConflict,
    ToolConfigurationError,
    ToolConfigurationNotFound,
    ToolConfigurationService,
)
from ..workflows import (
    CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
    CONTINUOUS_COLLABORATION_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    GOVERNED_IDIOM_CHAIN_WORKFLOW,
    GOVERNED_PI_AGENT_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
    workflow_catalog_view,
)
from .contracts import (
    ActivateHitlPolicyRequest,
    CreateSessionRequest,
    PreviewHitlPolicyRequest,
    ResolveHumanDecisionRequest,
    ReviseExecutionDraftRequest,
    ReviseModelCallDraftRequest,
    UpdateAgentProfileRequest,
    UpdatePiToolConfigurationRequest,
    UpdateSessionRequest,
)
from .errors import http_problem


@dataclass(frozen=True, slots=True)
class ProductApiDependencies:
    """Services read by the HTTP adapter; no service is constructed here."""

    settings: Settings
    model_catalog: ModelProviderCatalog | None
    product_sessions: ProductSessionService
    runtime_execution: RuntimeExecutionService
    governance: ExecutionGovernanceService
    tool_configurations: ToolConfigurationService
    agent_profiles: AgentProfileService
    review_store: InMemoryModelCallReviewStore
    pi_runtime: PiRuntimeManager | None


def create_product_router(dependencies: ProductApiDependencies) -> APIRouter:
    """Create the REST router without taking ownership of application state."""

    router = APIRouter()
    resolved = dependencies.settings
    model_catalog = dependencies.model_catalog
    product_sessions = dependencies.product_sessions
    runtime_execution = dependencies.runtime_execution
    governance = dependencies.governance
    tool_configurations = dependencies.tool_configurations
    agent_profiles = dependencies.agent_profiles
    review_store = dependencies.review_store
    pi_runtime = dependencies.pi_runtime

    @router.get("/api/health")
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
            "pi_agent": resolved.pi_runtime.health_view(),
        }

    def validate_model_selection(
        provider_id: str | None,
        model: str | None,
    ) -> tuple[str | None, str | None]:
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
            raise http_problem(status_code=422, error=error) from error
        return provider_id, model

    @router.post("/api/sessions", status_code=201)
    async def create_session(command: CreateSessionRequest) -> dict[str, Any]:
        provider_id, model = validate_model_selection(command.model_provider_id, command.model)
        return await product_sessions.create_session(
            title=command.title,
            provider_id=provider_id,
            model=model,
        )

    @router.get("/api/sessions")
    async def list_sessions(include_archived: bool = False) -> dict[str, Any]:
        values = await product_sessions.list_sessions(include_archived=include_archived)
        return {"sessions": values}

    @router.get("/api/sessions/{session_id}")
    async def get_session(session_id: str) -> dict[str, Any]:
        try:
            return await product_sessions.get_session(session_id)
        except ProductSessionNotFound as error:
            raise http_problem(status_code=404, error=error) from error

    @router.patch("/api/sessions/{session_id}")
    async def update_session(
        session_id: str,
        command: UpdateSessionRequest,
    ) -> dict[str, Any]:
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
            raise http_problem(status_code=404, error=error) from error
        except ProductSessionConflict as error:
            raise http_problem(status_code=409, error=error) from error

    @router.get("/api/sessions/{session_id}/messages")
    async def session_messages(session_id: str) -> dict[str, Any]:
        try:
            return {"messages": await product_sessions.list_messages(session_id)}
        except ProductSessionNotFound as error:
            raise http_problem(status_code=404, error=error) from error

    @router.get("/api/sessions/{session_id}/runs")
    async def session_runs(session_id: str) -> dict[str, Any]:
        try:
            runs = await product_sessions.list_runs(session_id)
            for run in runs:
                run["runtime_job"] = await runtime_execution.job_for_product_run(run["id"])
            return {"runs": runs}
        except ProductSessionNotFound as error:
            raise http_problem(status_code=404, error=error) from error

    @router.post("/api/sessions/{session_id}/agui-runs/{agui_run_id}/cancel")
    async def cancel_session_run(session_id: str, agui_run_id: str) -> dict[str, Any]:
        try:
            cancelled = await product_sessions.cancel_protocol_run(session_id, agui_run_id)
            await runtime_execution.request_cancel(
                product_run_id=cancelled["id"],
                request_key=f"cancel:{session_id}:{agui_run_id}",
            )
            return cancelled
        except ProductSessionNotFound as error:
            raise http_problem(status_code=404, error=error) from error
        except ProductSessionConflict as error:
            raise http_problem(status_code=409, error=error) from error

    @router.get("/api/sessions/{session_id}/runs/{run_id}/trace")
    async def run_trace(session_id: str, run_id: str) -> dict[str, Any]:
        try:
            return {"trace": await product_sessions.list_trace(session_id, run_id)}
        except ProductSessionNotFound as error:
            raise http_problem(status_code=404, error=error) from error

    @router.get("/api/sessions/{session_id}/workflows/{workflow_id}/latest-trace")
    async def latest_workflow_trace(
        session_id: str,
        workflow_id: str,
    ) -> dict[str, Any]:
        try:
            return {
                "trace": await product_sessions.latest_workflow_trace(
                    session_id,
                    workflow_id,
                )
            }
        except ProductSessionNotFound as error:
            raise http_problem(status_code=404, error=error) from error

    @router.get("/api/workflows")
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

    @router.get("/api/hitl/decision-points")
    async def hitl_decision_points() -> dict[str, Any]:
        return {"decision_points": await governance.decision_points()}

    @router.get("/api/hitl/policy-sets")
    async def hitl_policy_sets() -> dict[str, Any]:
        return {"policy_sets": await governance.policy_sets()}

    @router.get("/api/hitl/decision-requests")
    async def hitl_decision_requests(
        session_id: str | None = None,
        status: str = "pending",
        limit: int = 100,
    ) -> dict[str, Any]:
        return {
            "decision_requests": await governance.human_decision_requests(
                session_id=session_id,
                status=status,
                limit=limit,
            )
        }

    @router.post("/api/hitl/policy-sets/activate")
    async def activate_hitl_policy(
        command: ActivateHitlPolicyRequest,
    ) -> dict[str, Any]:
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
            raise http_problem(status_code=409, error=error) from error
        except GovernanceValidationError as error:
            raise http_problem(status_code=422, error=error) from error

    @router.post("/api/hitl/policy-preview")
    async def preview_hitl_policy(
        command: PreviewHitlPolicyRequest,
    ) -> dict[str, Any]:
        try:
            return await governance.preview(
                decision_point_key=command.decision_point_key,
                scopes=command.scopes,
                facts=command.facts,
            )
        except GovernanceValidationError as error:
            raise http_problem(status_code=422, error=error) from error

    @router.get("/api/runs/{run_id}/governance")
    async def run_governance(run_id: str) -> dict[str, Any]:
        try:
            return await governance.governance_for_run(run_id)
        except GovernanceValidationError as error:
            raise http_problem(status_code=404, error=error) from error

    @router.get("/api/execution-drafts/{draft_id}")
    async def get_execution_draft(draft_id: str) -> dict[str, Any]:
        try:
            return await governance.execution_draft_view(draft_id)
        except GovernanceConflict as error:
            raise http_problem(status_code=409, error=error) from error
        except GovernanceValidationError as error:
            raise http_problem(status_code=404, error=error) from error

    @router.put("/api/execution-drafts/{draft_id}")
    async def revise_execution_draft(
        draft_id: str,
        command: ReviseExecutionDraftRequest,
    ) -> dict[str, Any]:
        try:
            return await governance.revise_execution_draft(
                draft_id=draft_id,
                expected_revision_id=command.expected_revision_id,
                expected_draft_hash=command.expected_draft_hash,
                expected_row_version=command.expected_row_version,
                payload=command.payload,
                execution_brief=command.execution_brief,
                author_id=governance.principal_id,
            )
        except GovernanceConflict as error:
            raise http_problem(status_code=409, error=error) from error
        except GovernanceValidationError as error:
            raise http_problem(status_code=422, error=error) from error

    @router.post("/api/hitl/decision-requests/{request_id}/resolve")
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
                response_payload=command.response_payload,
                resume_via_outbox=True,
            )
            return {
                "decision_request_id": request_id,
                "status": "decision_recorded",
                "decisions": decisions,
            }
        except GovernanceConflict as error:
            raise http_problem(status_code=409, error=error) from error
        except GovernanceValidationError as error:
            raise http_problem(status_code=422, error=error) from error

    @router.get("/api/tools")
    async def tools() -> dict[str, Any]:
        return {"tools": await tool_configurations.list()}

    @router.get("/api/tools/pi_agent/executions")
    async def pi_tool_executions(limit: int = 20) -> dict[str, Any]:
        return {"executions": await tool_configurations.executions(limit)}

    @router.put("/api/tools/pi_agent")
    async def update_pi_tool(
        command: UpdatePiToolConfigurationRequest,
    ) -> dict[str, Any]:
        try:
            return await tool_configurations.update(**command.model_dump())
        except ToolConfigurationNotFound as error:
            raise http_problem(status_code=404, error=error) from error
        except ToolConfigurationConflict as error:
            raise http_problem(status_code=409, error=error) from error
        except ToolConfigurationError as error:
            raise http_problem(status_code=422, error=error) from error

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
            raise http_problem(status_code=502, error=error) from error

    @router.post("/api/pi-provider/v1/chat/completions", include_in_schema=False)
    async def pi_chat_completions_gateway(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        return await pi_provider_gateway(
            request,
            authorization,
            "openai_chat_completions",
        )

    @router.post("/api/pi-provider/v1/responses", include_in_schema=False)
    async def pi_responses_gateway(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        return await pi_provider_gateway(request, authorization, "openai_responses")

    @router.post("/api/pi-read-tools/{tool_name}", include_in_schema=False)
    async def pi_read_tool_gateway(
        tool_name: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        if pi_runtime is None:
            raise HTTPException(status_code=503, detail="pi只读Tool Gateway不可用")
        try:
            return await pi_runtime.read_tool_response(
                authorization=authorization,
                tool_name=tool_name,
                body=await request.body(),
            )
        except PiRuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @router.get("/api/agents")
    async def agents() -> dict[str, Any]:
        return {"agents": await agent_profiles.list()}

    @router.put("/api/agents/{agent_id}")
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
            raise http_problem(status_code=404, error=error) from error
        except AgentProfileConflict as error:
            raise http_problem(status_code=409, error=error) from error
        except AgentProfileError as error:
            raise http_problem(status_code=422, error=error) from error

    @router.get("/api/model-call-drafts/{draft_id}")
    async def get_model_call_draft(draft_id: str) -> dict[str, Any]:
        try:
            return review_store.review_card(draft_id)
        except LookupError as error:
            raise HTTPException(status_code=404, detail="模型调用草稿不存在") from error

    @router.get("/api/model-providers")
    async def model_providers() -> dict[str, Any]:
        if model_catalog is None:
            return {
                "default_provider_id": None,
                "default_model": None,
                "providers": [],
            }
        return {
            "default_provider_id": model_catalog.default_provider_id,
            "default_model": model_catalog.default_model,
            "providers": model_catalog.public_view(),
        }

    @router.put("/api/model-call-drafts/{draft_id}")
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
            raise http_problem(status_code=409, error=error) from error
        except ModelCallDraftValidationError as error:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "模型调用请求未通过校验",
                    "issues": list(error.issues),
                },
            ) from error
        return revised.review_card()

    return router

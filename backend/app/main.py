"""FastAPI composition root for the independent Chat product."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from agent_framework.ag_ui import add_agent_framework_fastapi_endpoint
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict

from .agents import create_agent
from .config import Settings
from .model_call_review import (
    ExactProviderTransport,
    InMemoryModelCallReviewStore,
    ModelCallDraftConflict,
    ModelCallDraftValidationError,
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
from .workflows import (
    NESTED_QUALITY_WORKFLOW,
    ProductAwareWorkflow,
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


def create_app(
    settings: Settings | None = None,
    *,
    model_call_store: InMemoryModelCallReviewStore | None = None,
    model_call_transport: ProviderTransport | None = None,
    product_session_service: ProductSessionService | None = None,
) -> FastAPI:
    """Create an isolated app instance suitable for production or contract tests."""

    resolved = settings or Settings.from_file()
    model_catalog = resolved.model_catalog()
    product_sessions = product_session_service or ProductSessionService(
        ProductDatabase(resolved.database_url)
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await product_sessions.initialize()
        try:
            yield
        finally:
            await product_sessions.database.close()

    app = FastAPI(
        title="Chat",
        version="0.1.0",
        description="Independent AI collaboration Chat product powered by MAF and AG-UI.",
        lifespan=lifespan,
    )
    app.state.settings = resolved
    review_store = model_call_store or InMemoryModelCallReviewStore(model_catalog)
    app.state.model_call_review_store = review_store
    app.state.product_sessions = product_sessions
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
        return {"workflows": workflow_catalog_view()}

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
    return app


app = create_app()

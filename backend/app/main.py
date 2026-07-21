"""FastAPI composition root for the independent Chat product."""

from __future__ import annotations

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


class ReviseModelCallDraftRequest(BaseModel):
    """Replace every editable field in one provider request draft."""

    model_config = ConfigDict(extra="forbid")

    expected_hash: str
    provider_id: str
    provider_request: dict[str, Any]


def create_app(
    settings: Settings | None = None,
    *,
    model_call_store: InMemoryModelCallReviewStore | None = None,
    model_call_transport: ProviderTransport | None = None,
) -> FastAPI:
    """Create an isolated app instance suitable for production or contract tests."""

    resolved = settings or Settings.from_file()
    model_catalog = resolved.model_catalog()
    app = FastAPI(
        title="Chat",
        version="0.1.0",
        description="Independent AI collaboration Chat product powered by MAF and AG-UI.",
    )
    app.state.settings = resolved
    review_store = model_call_store or InMemoryModelCallReviewStore(model_catalog)
    app.state.model_call_review_store = review_store
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
        }

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
        )
    else:
        runner = create_agent(resolved)
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
    return app


app = create_app()

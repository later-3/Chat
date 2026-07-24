"""FastAPI application factory for the independent Chat product."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import CorrelationMiddleware, install_error_handlers, problem_responses
from .api.product_router import ProductApiDependencies, create_product_router
from .collaboration_contexts.api import create_collaboration_context_router
from .collaboration_intents.api import create_collaboration_intent_router
from .collaboration_protocols.api import create_collaboration_protocol_router
from .composition import (
    build_components,
    expose_components,
    register_runtime_surfaces,
)
from .config import Settings
from .harness.api import create_harness_router
from .lifecycle import create_lifespan
from .model_call_review import InMemoryModelCallReviewStore
from .model_call_workflow import ProviderTransport
from .observability.diagnostics import create_diagnostics_router
from .observability.logging import configure_observability
from .pi_runtime import PiRuntimeManager
from .product_sessions import ProductSessionService
from .runtime_execution.endpoint import add_runtime_management_endpoints
from .step_inputs.api import create_step_input_router


def create_app(
    settings: Settings | None = None,
    *,
    model_call_store: InMemoryModelCallReviewStore | None = None,
    model_call_transport: ProviderTransport | None = None,
    product_session_service: ProductSessionService | None = None,
    pi_runtime_manager: PiRuntimeManager | None = None,
    start_outbox_worker: bool = True,
    outbox_worker_id: str | None = None,
    start_execution_worker: bool = True,
    execution_worker_id: str | None = None,
) -> FastAPI:
    """Compose one isolated API and runtime process.

    The factory wires adapters only. Product rules remain in application
    services, HTTP translation remains in routers, and worker start/stop
    ownership remains in the lifespan module.
    """

    resolved = settings or Settings.from_file()
    configure_observability(resolved.observability)
    components = build_components(
        resolved,
        model_call_store=model_call_store,
        model_call_transport=model_call_transport,
        product_session_service=product_session_service,
        pi_runtime_manager=pi_runtime_manager,
        execution_worker_id=execution_worker_id,
    )
    app = FastAPI(
        title="Chat",
        version="0.1.0",
        description="Independent AI collaboration Chat product powered by MAF and AG-UI.",
        lifespan=create_lifespan(
            components,
            start_outbox_worker=start_outbox_worker,
            start_execution_worker=start_execution_worker,
        ),
        responses=problem_responses(),
    )
    install_error_handlers(app)
    expose_components(app, components)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.frontend_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[
            "X-Request-ID",
            "X-Runtime-Cursor",
            "X-Runtime-Job-Id",
        ],
    )
    app.add_middleware(CorrelationMiddleware)

    app.include_router(create_harness_router(components.harness))
    app.include_router(create_collaboration_context_router(components.collaboration_contexts))
    app.include_router(create_collaboration_intent_router(components.collaboration_intents))
    app.include_router(create_collaboration_protocol_router(components.collaboration_protocols))
    app.include_router(create_diagnostics_router(components.diagnostics))
    app.include_router(create_step_input_router(components.step_inputs))
    add_runtime_management_endpoints(
        app,
        runtime=components.runtime_execution,
    )
    app.include_router(
        create_product_router(
            ProductApiDependencies(
                settings=resolved,
                model_catalog=components.model_catalog,
                product_sessions=components.product_sessions,
                runtime_execution=components.runtime_execution,
                governance=components.governance,
                tool_configurations=components.tool_configurations,
                agent_profiles=components.agent_profiles,
                review_store=components.review_store,
                pi_runtime=components.pi_runtime,
            )
        )
    )
    register_runtime_surfaces(
        app,
        components,
        outbox_worker_id=outbox_worker_id,
    )
    return app


def create_api_app() -> FastAPI:
    """Production API factory when Outbox delivery runs separately."""

    return create_app(
        start_outbox_worker=False,
        start_execution_worker=False,
    )

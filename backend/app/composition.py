"""Dependency composition for the Chat application.

This module constructs adapters and application services. HTTP routes and
product rules consume these objects but never construct or replace them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import FastAPI

from .agent_profiles import AgentProfileService
from .agents import create_agent
from .collaboration_contexts import CollaborationContextService
from .collaboration_intents import CollaborationIntentService
from .collaboration_protocols import CollaborationProtocolService
from .config import ModelProviderCatalog, Settings
from .governance import ExecutionGovernanceService, GovernanceOutboxWorker
from .harness import HarnessService
from .harness.outbox import ProductOutboxRouter
from .model_call_review import (
    ExactProviderTransport,
    InMemoryModelCallReviewStore,
    RoutedProviderTransport,
    provider_endpoint,
)
from .model_call_workflow import ProviderTransport, create_model_call_workflow
from .observability.diagnostics import DiagnosticsService
from .pi_runtime import PiRuntimeManager
from .product_sessions import ProductDatabase, ProductSessionService
from .product_sessions.agui import ProductAwareAgentFrameworkAgent
from .runtime_execution import (
    ExecutionWorker,
    RuntimeExecutionService,
    RuntimeRunnerRegistry,
)
from .runtime_execution.endpoint import add_durable_agui_endpoint
from .step_inputs import StepInputProjectionService
from .tool_configs import ToolConfigurationService
from .workflows import (
    CONTINUOUS_COLLABORATION_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    GOVERNED_IDIOM_CHAIN_WORKFLOW,
    GOVERNED_PI_AGENT_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
    ProductAwareWorkflow,
    ProductWorkflowCheckpointStorage,
    create_continuous_collaboration_workflow,
    create_governed_agent_handoff_workflow,
    create_governed_idiom_chain_workflow,
    create_governed_pi_agent_workflow,
    create_nested_quality_workflow,
)
from .workflows.resume_worker import RuntimeResumeOutboxHandler


@dataclass(slots=True)
class ApplicationComponents:
    """Process-local adapters and services assembled for one FastAPI app."""

    settings: Settings
    model_catalog: ModelProviderCatalog | None
    product_sessions: ProductSessionService
    agent_profiles: AgentProfileService
    review_store: InMemoryModelCallReviewStore
    tool_configurations: ToolConfigurationService
    governance: ExecutionGovernanceService
    harness: HarnessService
    collaboration_contexts: CollaborationContextService
    collaboration_intents: CollaborationIntentService
    collaboration_protocols: CollaborationProtocolService
    runtime_execution: RuntimeExecutionService
    step_inputs: StepInputProjectionService
    diagnostics: DiagnosticsService
    runtime_registry: RuntimeRunnerRegistry
    execution_worker: ExecutionWorker
    pi_runtime: PiRuntimeManager | None
    injected_transport: ProviderTransport | None
    governance_outbox_worker: GovernanceOutboxWorker | None = None


def build_components(
    settings: Settings,
    *,
    model_call_store: InMemoryModelCallReviewStore | None = None,
    model_call_transport: ProviderTransport | None = None,
    product_session_service: ProductSessionService | None = None,
    pi_runtime_manager: PiRuntimeManager | None = None,
    execution_worker_id: str | None = None,
) -> ApplicationComponents:
    """Construct the process-local object graph without starting it."""

    model_catalog = settings.model_catalog()
    product_sessions = product_session_service or ProductSessionService(
        ProductDatabase(settings.database_url)
    )
    review_store = model_call_store or InMemoryModelCallReviewStore(model_catalog)
    runtime_execution = RuntimeExecutionService(product_sessions.database)
    runtime_registry = RuntimeRunnerRegistry()
    execution_worker = ExecutionWorker(
        product_sessions.database,
        runtime=runtime_execution,
        registry=runtime_registry,
        worker_id=execution_worker_id or f"api-execution-{os.getpid()}-{id(product_sessions):x}",
        sessions=product_sessions,
    )
    pi_runtime = pi_runtime_manager or (
        PiRuntimeManager(
            runtime=settings.pi_runtime,
            catalog=model_catalog,
            review_store=review_store,
        )
        if model_catalog is not None
        else None
    )
    return ApplicationComponents(
        settings=settings,
        model_catalog=model_catalog,
        product_sessions=product_sessions,
        agent_profiles=AgentProfileService(
            product_sessions.database,
            model_catalog,
        ),
        review_store=review_store,
        tool_configurations=ToolConfigurationService(
            product_sessions.database,
            model_catalog,
            settings.pi_runtime,
        ),
        governance=ExecutionGovernanceService(product_sessions.database),
        harness=HarnessService(product_sessions.database),
        collaboration_contexts=CollaborationContextService(product_sessions.database),
        collaboration_intents=CollaborationIntentService(product_sessions.database),
        collaboration_protocols=CollaborationProtocolService(product_sessions.database),
        runtime_execution=runtime_execution,
        step_inputs=StepInputProjectionService(product_sessions.database),
        diagnostics=DiagnosticsService(product_sessions.database),
        runtime_registry=runtime_registry,
        execution_worker=execution_worker,
        pi_runtime=pi_runtime,
        injected_transport=model_call_transport,
    )


def expose_components(app: FastAPI, components: ApplicationComponents) -> None:
    """Publish compatibility handles used by tests and process adapters."""

    app.state.settings = components.settings
    app.state.model_call_review_store = components.review_store
    app.state.product_sessions = components.product_sessions
    app.state.agent_profiles = components.agent_profiles
    app.state.tool_configurations = components.tool_configurations
    app.state.governance = components.governance
    app.state.harness = components.harness
    app.state.collaboration_contexts = components.collaboration_contexts
    app.state.collaboration_intents = components.collaboration_intents
    app.state.collaboration_protocols = components.collaboration_protocols
    app.state.runtime_execution = components.runtime_execution
    app.state.step_inputs = components.step_inputs
    app.state.diagnostics = components.diagnostics
    app.state.runtime_registry = components.runtime_registry
    app.state.execution_worker = components.execution_worker
    app.state.governance_outbox_worker = components.governance_outbox_worker
    app.state.pi_runtime = components.pi_runtime


def register_runtime_surfaces(
    app: FastAPI,
    components: ApplicationComponents,
    *,
    outbox_worker_id: str | None,
) -> None:
    """Register AG-UI surfaces and bind the matching runtime runners."""

    resolved = components.settings
    model_catalog = components.model_catalog
    product_sessions = components.product_sessions
    review_store = components.review_store
    runtime_execution = components.runtime_execution
    runtime_registry = components.runtime_registry
    governance = components.governance
    transport: ProviderTransport | None = None

    if resolved.runtime_mode == "model":
        assert model_catalog is not None
        transport = components.injected_transport or RoutedProviderTransport(
            transports={
                provider.id: ExactProviderTransport(
                    endpoint=provider_endpoint(
                        provider.base_url,
                        provider.protocol,
                    ),
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
    add_durable_agui_endpoint(
        app,
        runner,
        "/api/agent",
        sessions=product_sessions,
        runtime=runtime_execution,
        registry=runtime_registry,
        workflow_definition_id="direct-agent",
        workflow_version="1.0.0",
        tags=["agent"],
    )

    visible_workflow = ProductAwareWorkflow(
        workflow_factory=lambda _: create_nested_quality_workflow(),
        sessions=product_sessions,
        definition=NESTED_QUALITY_WORKFLOW,
    )
    app.state.visible_workflow = visible_workflow
    add_durable_agui_endpoint(
        app,
        visible_workflow,
        NESTED_QUALITY_WORKFLOW.endpoint,
        sessions=product_sessions,
        runtime=runtime_execution,
        registry=runtime_registry,
        workflow_definition_id=NESTED_QUALITY_WORKFLOW.id,
        workflow_version=NESTED_QUALITY_WORKFLOW.version,
        tags=["workflows"],
    )

    if resolved.runtime_mode == "model":
        assert transport is not None
        _register_model_workflows(app, components, transport)
        components.governance_outbox_worker = GovernanceOutboxWorker(
            product_sessions.database,
            worker_id=outbox_worker_id or f"api-outbox-{os.getpid()}-{id(app):x}",
            handler=ProductOutboxRouter(
                RuntimeResumeOutboxHandler(
                    governance,
                    runtime=runtime_execution,
                )
            ),
        )

    if components.governance_outbox_worker is None:
        components.governance_outbox_worker = GovernanceOutboxWorker(
            product_sessions.database,
            worker_id=outbox_worker_id or f"api-outbox-{os.getpid()}-{id(app):x}",
            handler=ProductOutboxRouter(None),
        )
    app.state.governance_outbox_worker = components.governance_outbox_worker


def _register_model_workflows(
    app: FastAPI,
    components: ApplicationComponents,
    transport: ProviderTransport,
) -> None:
    product_sessions = components.product_sessions
    runtime_execution = components.runtime_execution
    runtime_registry = components.runtime_registry
    governance = components.governance

    continuous_run_ids: dict[str, str] = {}

    def continuous_checkpoint_storage(
        product_run_id: str,
    ) -> ProductWorkflowCheckpointStorage:
        return ProductWorkflowCheckpointStorage(
            product_sessions.database,
            product_run_id=product_run_id,
            workflow_definition_id=CONTINUOUS_COLLABORATION_WORKFLOW.id,
            workflow_version=CONTINUOUS_COLLABORATION_WORKFLOW.version,
        )

    def continuous_factory(thread_id: str):
        product_run_id = continuous_run_ids.get(thread_id, "unknown")
        return create_continuous_collaboration_workflow(
            thread_id=thread_id,
            run_id=lambda: continuous_run_ids.get(thread_id, "unknown"),
            profiles={
                key: components.agent_profiles.runtime_snapshot(key)
                for key in (
                    "intent_router",
                    "task_planner",
                    "response_agent",
                    "turn_summarizer",
                )
            },
            store=components.review_store,
            transport=transport,
            sessions=product_sessions,
            governance=governance,
            harness=components.harness,
            collaboration_protocols=components.collaboration_protocols,
            collaboration_intents=components.collaboration_intents,
            checkpoint_storage=continuous_checkpoint_storage(product_run_id),
        )

    continuous_workflow = ProductAwareWorkflow(
        workflow_factory=continuous_factory,
        sessions=product_sessions,
        definition=CONTINUOUS_COLLABORATION_WORKFLOW,
        run_ids=continuous_run_ids,
        governance=governance,
        checkpoint_storage_factory=continuous_checkpoint_storage,
    )
    app.state.continuous_workflow = continuous_workflow
    add_durable_agui_endpoint(
        app,
        continuous_workflow,
        CONTINUOUS_COLLABORATION_WORKFLOW.endpoint,
        sessions=product_sessions,
        runtime=runtime_execution,
        registry=runtime_registry,
        workflow_definition_id=CONTINUOUS_COLLABORATION_WORKFLOW.id,
        workflow_version=CONTINUOUS_COLLABORATION_WORKFLOW.version,
        tags=["workflows"],
    )

    handoff_run_ids: dict[str, str] = {}

    def handoff_factory(thread_id: str):
        return create_governed_agent_handoff_workflow(
            thread_id=thread_id,
            run_id=lambda: handoff_run_ids.get(thread_id, "unknown"),
            planner=components.agent_profiles.runtime_snapshot("planner"),
            reviewer=components.agent_profiles.runtime_snapshot("reviewer"),
            store=components.review_store,
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
    add_durable_agui_endpoint(
        app,
        handoff_workflow,
        GOVERNED_AGENT_HANDOFF_WORKFLOW.endpoint,
        sessions=product_sessions,
        runtime=runtime_execution,
        registry=runtime_registry,
        workflow_definition_id=GOVERNED_AGENT_HANDOFF_WORKFLOW.id,
        workflow_version=GOVERNED_AGENT_HANDOFF_WORKFLOW.version,
        tags=["workflows"],
    )

    idiom_run_ids: dict[str, str] = {}

    def idiom_factory(thread_id: str):
        return create_governed_idiom_chain_workflow(
            thread_id=thread_id,
            run_id=lambda: idiom_run_ids.get(thread_id, "unknown"),
            agent_a=components.agent_profiles.runtime_snapshot("idiom_agent_a"),
            agent_b=components.agent_profiles.runtime_snapshot("idiom_agent_b"),
            store=components.review_store,
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
    add_durable_agui_endpoint(
        app,
        idiom_workflow,
        GOVERNED_IDIOM_CHAIN_WORKFLOW.endpoint,
        sessions=product_sessions,
        runtime=runtime_execution,
        registry=runtime_registry,
        workflow_definition_id=GOVERNED_IDIOM_CHAIN_WORKFLOW.id,
        workflow_version=GOVERNED_IDIOM_CHAIN_WORKFLOW.version,
        tags=["workflows"],
    )

    if components.settings.pi_runtime.available and components.pi_runtime is not None:
        pi_run_ids: dict[str, str] = {}
        pi_runtime = components.pi_runtime

        def pi_factory(thread_id: str):
            return create_governed_pi_agent_workflow(
                thread_id=thread_id,
                run_id=lambda: pi_run_ids.get(thread_id, "unknown"),
                config=components.tool_configurations.runtime_snapshot(),
                manager=pi_runtime,
                store=components.review_store,
                sessions=product_sessions,
                tools=components.tool_configurations,
            )

        pi_workflow = ProductAwareWorkflow(
            workflow_factory=pi_factory,
            sessions=product_sessions,
            definition=GOVERNED_PI_AGENT_WORKFLOW,
            run_ids=pi_run_ids,
        )
        app.state.pi_workflow = pi_workflow
        add_durable_agui_endpoint(
            app,
            pi_workflow,
            GOVERNED_PI_AGENT_WORKFLOW.endpoint,
            sessions=product_sessions,
            runtime=runtime_execution,
            registry=runtime_registry,
            workflow_definition_id=GOVERNED_PI_AGENT_WORKFLOW.id,
            workflow_version=GOVERNED_PI_AGENT_WORKFLOW.version,
            tags=["workflows"],
        )

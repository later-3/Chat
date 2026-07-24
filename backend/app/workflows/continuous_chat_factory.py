"""Composition-only graph factory for the continuous collaboration Workflow.

The concrete Executors remain in ``continuous_chat`` while they are split in
small, behavior-preserving slices. Keeping graph wiring here makes node IDs,
edge order and checkpoint compatibility reviewable without mixing them with
Executor behavior.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from agent_framework import Case, CheckpointStorage, Default, WorkflowBuilder

from ..agent_profiles import AgentProfileSnapshot
from ..collaboration_intents import CollaborationIntentService
from ..collaboration_protocols import CollaborationProtocolService
from ..governance.service import ExecutionGovernanceService
from ..harness import HarnessService
from ..model_call_review import InMemoryModelCallReviewStore
from ..model_call_workflow import ProviderTransport
from ..product_sessions.service import ProductSessionService
from .continuous_chat_contracts import CollaborationState
from .continuous_chat_prompts import (
    intent_task,
    plan_task,
    response_task,
    summary_task,
)


@dataclass(frozen=True, slots=True)
class ContinuousWorkflowComponents:
    """Executor constructors and predicates owned by the behavior module."""

    workflow_id: str
    intake: type[Any]
    candidates: type[Any]
    directory_context: type[Any]
    decision: type[Any]
    semantic_agent: type[Any]
    intent_projection: type[Any]
    intent_acceptance: type[Any]
    project_resolver: type[Any]
    protocol_resolver: type[Any]
    router: type[Any]
    detail_context: type[Any]
    project_catalog: type[Any]
    execution_draft_compiler: type[Any]
    run_spec_compiler: type[Any]
    clarification: type[Any]
    harness_commit: type[Any]
    summary_persist: type[Any]
    finalizer: type[Any]
    decision_specs: Callable[[], Mapping[str, Any]]
    is_project_catalog_state: Callable[[CollaborationState], bool]
    needs_plan: Callable[[CollaborationState], bool]


def build_continuous_collaboration_workflow(
    *,
    components: ContinuousWorkflowComponents,
    thread_id: str,
    run_id: Callable[[], str],
    profiles: Mapping[str, AgentProfileSnapshot],
    store: InMemoryModelCallReviewStore,
    transport: ProviderTransport,
    sessions: ProductSessionService,
    governance: ExecutionGovernanceService,
    harness: HarnessService | None = None,
    collaboration_protocols: CollaborationProtocolService | None = None,
    collaboration_intents: CollaborationIntentService | None = None,
    checkpoint_storage: CheckpointStorage | None = None,
):
    """Build the versioned graph without mutating product or runtime state."""

    harness = harness or HarnessService(sessions.database)
    collaboration_protocols = collaboration_protocols or CollaborationProtocolService(sessions.database)
    collaboration_intents = collaboration_intents or CollaborationIntentService(sessions.database)
    decision_specs = components.decision_specs()
    intake = components.intake(
        thread_id=thread_id,
        sessions=sessions,
        governance=governance,
        intents=collaboration_intents,
    )
    candidates = components.candidates(thread_id=thread_id, sessions=sessions)
    directory_context = components.directory_context(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
    )
    context_decision = components.decision(
        node_id="context_adoption",
        spec=decision_specs["context_adoption"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    intent = components.semantic_agent(
        profile=profiles["intent_router"],
        node_id="intent_agent",
        call_ordinal=1,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
        governance=governance,
        task_builder=intent_task,
        result_kind="intent",
    )
    intent_projection = components.intent_projection(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        intents=collaboration_intents,
    )
    intent_decision = components.decision(
        node_id="intent_binding",
        spec=decision_specs["intent_binding"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    intent_acceptance = components.intent_acceptance(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        intents=collaboration_intents,
    )
    project_resolver = components.project_resolver(
        thread_id=thread_id,
        sessions=sessions,
        harness=harness,
    )
    project_decision = components.decision(
        node_id="project_work_binding",
        spec=decision_specs["project_work_binding"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    router = components.router(thread_id=thread_id, sessions=sessions)
    detail_context = components.detail_context(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
    )
    protocol_resolver = components.protocol_resolver(
        thread_id=thread_id,
        sessions=sessions,
        collaboration_protocols=collaboration_protocols,
    )
    project_catalog = components.project_catalog(
        thread_id=thread_id,
        sessions=sessions,
        harness=harness,
    )
    planner = components.semantic_agent(
        profile=profiles["task_planner"],
        node_id="planning_agent",
        call_ordinal=2,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
        governance=governance,
        task_builder=plan_task,
        result_kind="plan",
    )
    plan_decision = components.decision(
        node_id="plan_acceptance",
        spec=decision_specs["plan_acceptance"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    compiler = components.execution_draft_compiler(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    execution_decision = components.decision(
        node_id="execution_authorization",
        spec=decision_specs["execution_authorization"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    run_spec_compiler = components.run_spec_compiler(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    responder = components.semantic_agent(
        profile=profiles["response_agent"],
        node_id="response_agent",
        call_ordinal=3,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
        governance=governance,
        task_builder=response_task,
        result_kind="response",
    )
    result_decision = components.decision(
        node_id="result_commit",
        spec=decision_specs["result_commit"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    work_decision = components.decision(
        node_id="work_state_commit",
        spec=decision_specs["work_state_commit"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    memory_decision = components.decision(
        node_id="memory_commit",
        spec=decision_specs["memory_commit"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    harness_commit = components.harness_commit(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
    )
    summarizer = components.semantic_agent(
        profile=profiles["turn_summarizer"],
        node_id="turn_summary_agent",
        call_ordinal=4,
        thread_id=thread_id,
        run_id=run_id,
        store=store,
        transport=transport,
        sessions=sessions,
        governance=governance,
        task_builder=summary_task,
        result_kind="summary",
    )
    clarification = components.clarification(thread_id=thread_id, sessions=sessions)
    summary_persist = components.summary_persist(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    finalizer = components.finalizer(thread_id=thread_id, sessions=sessions)
    return (
        WorkflowBuilder(
            name=components.workflow_id,
            description="Chat主Workflow：选择性上下文、意图、场景路由、计划、响应与回合主题提取。",
            start_executor=intake,
            output_from=[finalizer],
            checkpoint_storage=checkpoint_storage,
        )
        .add_edge(intake, candidates)
        .add_edge(candidates, directory_context)
        .add_edge(directory_context, context_decision)
        .add_edge(context_decision, intent)
        .add_edge(intent, intent_projection)
        .add_edge(intent_projection, intent_decision)
        .add_edge(intent_decision, intent_acceptance)
        .add_edge(intent_acceptance, project_resolver)
        .add_edge(project_resolver, project_decision)
        .add_edge(project_decision, detail_context)
        .add_edge(detail_context, protocol_resolver)
        .add_edge(protocol_resolver, router)
        .add_switch_case_edge_group(
            router,
            [
                Case(condition=components.is_project_catalog_state, target=project_catalog),
                Case(condition=lambda value: value.scenario == "clarify", target=clarification),
                Case(condition=components.needs_plan, target=planner),
                Default(target=compiler),
            ],
        )
        .add_edge(planner, plan_decision)
        .add_edge(plan_decision, compiler)
        .add_edge(compiler, execution_decision)
        .add_edge(execution_decision, run_spec_compiler)
        .add_edge(run_spec_compiler, responder)
        .add_edge(responder, summarizer)
        .add_edge(summarizer, result_decision)
        .add_edge(project_catalog, result_decision)
        .add_edge(result_decision, work_decision)
        .add_edge(work_decision, memory_decision)
        .add_edge(memory_decision, harness_commit)
        .add_edge(harness_commit, summary_persist)
        .add_edge(clarification, summary_persist)
        .add_edge(summary_persist, finalizer)
        .build()
    )

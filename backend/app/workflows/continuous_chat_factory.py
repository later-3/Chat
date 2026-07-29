"""持续协作主Workflow的图装配文件：只创建节点并连接边，不实现领域行为。

阅读顺序：先看本文件知道39个节点如何连接，再到``continuous_chat.py``、
``execution_dispatch/workflow.py``和``execution_dispatch/result_gate.py``看节点行为。
把图连接单独保存，是因为节点ID、边顺序和图签名直接决定旧MAF Checkpoint能否恢复；
业务服务不能在这里偷偷改Product状态。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from agent_framework import Case, CheckpointStorage, Default, WorkflowBuilder

from ..agent_profiles import AgentProfileSnapshot
from ..collaboration_contexts import CollaborationContextService
from ..collaboration_intents import CollaborationIntentService
from ..collaboration_protocols import CollaborationProtocolService
from ..evidence.result_pipeline import ResultPipelineCoordinator
from ..execution_dispatch.repository_context import RepositoryExecutionContextService
from ..execution_dispatch.service import ExecutionDispatchService
from ..execution_dispatch.validation_contracts import ValidationContractPlanner
from ..governance.service import ExecutionGovernanceService
from ..harness import HarnessService
from ..model_call_review import InMemoryModelCallReviewStore
from ..model_call_workflow import ProviderTransport
from ..product_sessions.service import ProductSessionService
from ..project_resources.context import RepositorySourceFreshnessGuard
from .continuous_chat_contracts import CollaborationState
from .continuous_chat_prompts import (
    intent_task,
    plan_task,
    response_task,
    summary_task,
)


@dataclass(frozen=True, slots=True)
class ContinuousWorkflowComponents:
    """由行为模块提供的Executor构造器和分支谓词集合，避免工厂反向实现行为。"""

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
    context_revision: type[Any]
    project_catalog: type[Any]
    execution_draft_compiler: type[Any]
    run_spec_compiler: type[Any]
    execution_route: type[Any]
    execution_workspace_prepare: type[Any]
    pi_readonly_dispatch: type[Any]
    pi_readonly_result_assembly: type[Any]
    pi_workspace_dispatch: type[Any]
    pi_workspace_result_assembly: type[Any]
    result_claim_prepare: type[Any]
    result_claim_decision: type[Any]
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
    collaboration_contexts: CollaborationContextService | None = None,
    repository_freshness: RepositorySourceFreshnessGuard | None = None,
    repository_execution_context: RepositoryExecutionContextService,
    pi_available: bool,
    execution_dispatch: ExecutionDispatchService,
    result_pipeline: ResultPipelineCoordinator,
    validation_planner: ValidationContractPlanner,
    checkpoint_storage: CheckpointStorage | None = None,
):
    """构造同版本39节点图；本函数本身不修改Product或Runtime状态。"""

    harness = harness or HarnessService(sessions.database)
    collaboration_protocols = collaboration_protocols or CollaborationProtocolService(sessions.database)
    collaboration_intents = collaboration_intents or CollaborationIntentService(sessions.database)
    collaboration_contexts = collaboration_contexts or CollaborationContextService(sessions.database)
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
        harness=harness,
        collaboration_contexts=collaboration_contexts,
    )
    directory_context_revision = components.context_revision(
        node_id="directory_context_revision",
        stage="directory",
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
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
        repository_freshness=repository_freshness,
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
    detail_context_decision = components.decision(
        node_id="detail_context_adoption",
        spec=decision_specs["detail_context_adoption"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    detail_context_revision = components.context_revision(
        node_id="detail_context_revision",
        stage="detail",
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
        repository_freshness=repository_freshness,
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
        repository_execution_context=repository_execution_context,
        pi_available=pi_available,
        validation_planner=validation_planner,
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
    execution_route = components.execution_route(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        dispatch=execution_dispatch,
    )
    execution_workspace_prepare = components.execution_workspace_prepare(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        dispatch=execution_dispatch,
    )
    pi_readonly_dispatch = components.pi_readonly_dispatch(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        dispatch=execution_dispatch,
        store=store,
    )
    pi_readonly_result_assembly = components.pi_readonly_result_assembly(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        dispatch=execution_dispatch,
    )
    pi_workspace_dispatch = components.pi_workspace_dispatch(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        dispatch=execution_dispatch,
        store=store,
    )
    pi_workspace_result_assembly = components.pi_workspace_result_assembly(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        dispatch=execution_dispatch,
    )
    result_claim_prepare = components.result_claim_prepare(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        result_pipeline=result_pipeline,
    )
    result_claim_decision = components.result_claim_decision(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
        result_pipeline=result_pipeline,
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
        repository_freshness=repository_freshness,
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
        repository_freshness=repository_freshness,
    )
    clarification = components.clarification(thread_id=thread_id, sessions=sessions)
    summary_persist = components.summary_persist(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    finalizer = components.finalizer(thread_id=thread_id, sessions=sessions)
    # --- 图连接：以下边顺序就是运行定义 --------------------------------------
    # 修改节点或边会改变图签名，旧Checkpoint不能静默恢复；变更时必须升级Workflow版本。
    return (
        WorkflowBuilder(
            name=components.workflow_id,
            description="Chat主Workflow：选择性上下文、意图、场景路由、计划、响应与回合主题提取。",
            start_executor=intake,
            output_from=[finalizer],
            # pi dispatch作为中间输出源，确保内部Tool活动能实时投影到AG-UI事件Journal。
            intermediate_output_from=[pi_readonly_dispatch, pi_workspace_dispatch],
            checkpoint_storage=checkpoint_storage,
        )
        # 学习阶段S1（节点1-5）：输入 -> 摘要候选 -> 正式目录 -> Context采用 -> 最新revision。
        .add_edge(intake, candidates)
        .add_edge(candidates, directory_context)
        .add_edge(directory_context, context_decision)
        .add_edge(context_decision, directory_context_revision)
        # 学习阶段S2前半（节点6-11）：意图模型调用#1 -> 候选落库 -> 接受 -> Project绑定。
        .add_edge(directory_context_revision, intent)
        .add_edge(intent, intent_projection)
        .add_edge(intent_projection, intent_decision)
        .add_edge(intent_decision, intent_acceptance)
        .add_edge(intent_acceptance, project_resolver)
        .add_edge(project_resolver, project_decision)
        # 学习阶段S2后半（节点12-15）：只有Project绑定确认后，才加载详情Context并选择协议。
        .add_edge(project_decision, detail_context)
        .add_edge(detail_context, detail_context_decision)
        .add_edge(detail_context_decision, detail_context_revision)
        .add_edge(detail_context_revision, protocol_resolver)
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
        # 学习阶段S3/S4（节点16-24）：场景分支/计划 -> Draft -> 授权 -> RunSpec -> 执行路由。
        .add_edge(compiler, execution_decision)
        .add_edge(execution_decision, run_spec_compiler)
        .add_edge(run_spec_compiler, execution_route)
        .add_switch_case_edge_group(
            execution_route,
            [
                Case(
                    condition=lambda value: (
                        isinstance(value.execution_route, Mapping)
                        and value.execution_route.get("kind") == "pi_workspace"
                    ),
                    target=execution_workspace_prepare,
                ),
                Case(
                    condition=lambda value: (
                        isinstance(value.execution_route, Mapping)
                        and value.execution_route.get("kind") == "pi_readonly"
                    ),
                    target=pi_readonly_dispatch,
                ),
                Default(target=responder),
            ],
        )
        # 学习阶段S5（节点25-31）：pi隔离编辑/只读分支、结果装配和Completion Claim。
        .add_edge(execution_workspace_prepare, pi_workspace_dispatch)
        .add_edge(pi_workspace_dispatch, pi_workspace_result_assembly)
        .add_edge(pi_workspace_result_assembly, result_claim_prepare)
        .add_edge(result_claim_prepare, result_claim_decision)
        .add_edge(result_claim_decision, summarizer)
        .add_edge(pi_readonly_dispatch, pi_readonly_result_assembly)
        .add_edge(pi_readonly_result_assembly, summarizer)
        .add_edge(responder, summarizer)
        # 学习阶段S6/S7（节点32-39）：所有分支汇入答复/摘要，再依次处理Result、Work、Memory，
        # 最后提交Harness候选、保存TurnSummary并经过Product Message最终门。
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

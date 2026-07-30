"""持续协作主Workflow行为实现（v1.8.0，共39个真实MAF节点）。

本Workflow把“用户输入 -> 上下文 -> 意图 -> 执行合同 -> Agent/Tool执行 -> 证据
-> Product Message提交”串成一轮闭环。模型输出始终先是候选，只有对应提交门通过后
才可能成为Product事实。

从浏览器到终态的外层链路::

    React useChatAgent/useWorkflowAgent
      -> AG-UI POST + SSE
    runtime_execution/endpoint.py
      -> 创建Runtime Job；HTTP只订阅持久化事件Journal
    Execution Worker -> ProductAwareWorkflow.run()
      -> 准备Product Run/Attempt；恢复时加载MAF Checkpoint
    continuous_chat_factory.py
      -> 按本文件Executor行为连接39个节点
    FinalizeExecutor -> Product Finalization Gate
      -> 写Product Message和Run终态
      -> 同一终态事务生成机器版/人读版双Trace

39个节点按7个学习阶段理解：

1. 节点1-5：输入与目录上下文。
2. 节点6-15：Intent Set、Project绑定、详情Context和协作协议。
3. 节点16-20：目录查询/澄清/规划/直接执行的场景路由。
4. 节点21-24：ExecutionDraft、授权、不可变RunSpec与Runtime路由。
5. 节点25-31：pi只读/隔离执行、工作区、结果装配与Completion Claim。
6. 节点32-36：答复、回合摘要及Result/Work/Memory决定。
7. 节点37-39：提交已批准候选、保存TurnSummary、最终提交Assistant Message。

每次模型调用都经过``GovernedSemanticAgentExecutor``：先构造ModelCallDraft，再做
Policy评估和人工/自动决定，消费一次性Grant后才发送Provider；Provider返回也只先
成为候选。图连接单独放在``continuous_chat_factory``，因为节点ID、边顺序和图签名
会直接约束MAF Checkpoint能否恢复。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable, Mapping

from agent_framework import (
    CheckpointStorage,
    Executor,
    WorkflowContext,
    handler,
    response_handler,
)
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..agent_profiles import AgentProfileSnapshot
from ..collaboration_contexts import CollaborationContextService
from ..collaboration_intents import CollaborationIntentService
from ..collaboration_protocols import CollaborationProtocolService
from ..evidence.result_pipeline import ResultPipelineCoordinator
from ..execution_dispatch.drafts import (
    VALIDATION_CONTRACT_UNSET,
    adopted_repository_source,
    compile_execution_draft_v2,
    compile_run_spec_v2,
    execution_routing_text,
    recommends_pi_workspace_edit,
)
from ..execution_dispatch.repository_context import RepositoryExecutionContextService
from ..execution_dispatch.result_gate import (
    ResultClaimDecisionExecutor,
    ResultClaimPrepareExecutor,
)
from ..execution_dispatch.service import ExecutionDispatchService
from ..execution_dispatch.validation_contracts import ValidationContractPlanner
from ..execution_dispatch.workflow import (
    ExecutionRouteExecutor,
    ExecutionWorkspacePrepareExecutor,
    PiReadonlyDispatchExecutor,
    PiReadonlyResultAssemblyExecutor,
    PiWorkspaceDispatchExecutor,
    PiWorkspaceResultAssemblyExecutor,
)
from ..governance.service import ExecutionGovernanceService, GovernanceConflict
from ..harness import HarnessService
from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraft,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)
from ..model_call_workflow import (
    ProviderTransport,
    normalize_agui_messages_for_provider,
)
from ..product_sessions.service import ProductSessionService
from ..project_resources.context import (
    ContextSourceStale,
    RepositorySourceFreshnessGuard,
)
from ..step_inputs import StepInputProjectionService
from .continuous_chat_contracts import (
    CollaborationState,
)
from .continuous_chat_contracts import (
    apply_intent_set_protocol_overlay as _apply_intent_set_protocol_overlay,
)
from .continuous_chat_contracts import (
    apply_summary_writeback_policy as _apply_summary_writeback_policy,
)
from .continuous_chat_contracts import (
    canonical_hash as _hash,
)
from .continuous_chat_contracts import (
    context_keywords as _context_keywords,
)
from .continuous_chat_contracts import (
    context_source_references as _context_source_references,
)
from .continuous_chat_contracts import (
    evaluate_scenario_route as _evaluate_scenario_route,
)
from .continuous_chat_contracts import (
    is_pending_clarification as _is_pending_clarification,
)
from .continuous_chat_contracts import (
    is_project_catalog_query as _is_project_catalog_query,
)
from .continuous_chat_contracts import (
    is_project_catalog_state as _is_project_catalog_state,
)
from .continuous_chat_contracts import (
    json_object as _json_object,
)
from .continuous_chat_contracts import (
    message_text as _message_text,
)
from .continuous_chat_contracts import (
    needs_plan as _needs_plan,
)
from .continuous_chat_contracts import (
    normalize_intent_candidates as _normalize_intent_candidates,
)
from .continuous_chat_contracts import (
    project_catalog_intent as _project_catalog_intent,
)
from .continuous_chat_contracts import (
    project_hint as _project_hint,
)
from .continuous_chat_contracts import (
    render_project_catalog_result as _render_project_catalog_result,
)
from .continuous_chat_contracts import (
    state_from_snapshot as _state_from_snapshot,
)
from .continuous_chat_factory import (
    ContinuousWorkflowComponents,
    build_continuous_collaboration_workflow,
)

logger = logging.getLogger(__name__)

WORKFLOW_ID = "continuous-collaboration"
WORKFLOW_VERSION = "1.8.0"


class TraceMixin:
    """所有节点共用的Product Trace和StepInput写入能力。

    节点公开输入/输出写到活动Product Run；MAF事件存储不拥有产品Trace。只记录稳定、
    可展示、已脱敏字段，不记录密钥或模型隐藏推理。终态双报告正是从这些公开事实生成。
    """

    def _trace_init(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        """绑定Product Session定位与ProductSessionService，并构造StepInput投影服务。"""

        self._thread_id = thread_id
        self._sessions = sessions
        self._step_inputs = StepInputProjectionService(sessions.database)

    # BP-08 触发：Trace写入热点。多个Executor继承TraceMixin，每次写入Trace记录时都调用。
    # 频繁触发，初学者按需启用。
    # 对应文档：项目掌握/Trace与可观测性/每轮双Trace如何保存、分析与可视化.md
    async def _trace_content(
        self,
        *,
        executor_id: str,
        public_input: Any,
        public_output: Any,
        actor: str,
        content_type: str,
    ) -> None:
        """写入一个节点的公开输入/输出Trace，并按需持久化StepInputProjection。

        Trace写入热点。多个Executor继承TraceMixin，每次写入Trace记录时都调用。
        频繁触发，初学者按需启用。

        语义类内容（intent/plan/response/summary）只有确定性actor才额外记录StepInput投影--
        模型语义的步骤输入已由ModelCallDraft链承担，避免双写。无活动Run时跳过（如图外诊断
        调用），不伪造归属。工作台节点详情与终态双报告都以这里的事实为源。

        对应文档：项目掌握/Trace与可观测性/每轮双Trace如何保存、分析与可视化.md
        """

        # DEBUG-BREAKPOINT-NOTE: BP-08
        # DEBUG-BREAKPOINT-NOTE: 触发: Trace写入热点。
        # DEBUG-BREAKPOINT-NOTE: 触发: 多个Executor继承TraceMixin，每次写入Trace记录时都调用此方法。
        # DEBUG-BREAKPOINT-NOTE: 触发: Trace是可审计的执行日志，记录每一步的输入、输出和状态变更。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：每轮双Trace如何保存、分析与可视化。
        # DEBUG-BREAKPOINT-NOTE: 触发: 此断点频繁触发，初学者按需启用。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每次Trace写入触发1次（频繁）
        breakpoint()  # DEBUG-BREAKPOINT: BP-08
        active = await self._sessions.active_run(self._thread_id)
        if active is None:
            return
        projection: dict[str, Any] | None = None
        if content_type not in {
            "intent",
            "plan",
            "response",
            "summary",
            "context_source_freshness",
        } or actor.startswith("deterministic_"):
            public_input_mapping = (
                dict(public_input) if isinstance(public_input, Mapping) else {"value": public_input}
            )
            projection = await self._step_inputs.record(
                run_id=str(active["id"]),
                workflow_definition_id=WORKFLOW_ID,
                workflow_version=WORKFLOW_VERSION,
                node_id=executor_id,
                input_value=public_input_mapping,
                agent_profile_key=_optional_string(public_input_mapping.get("agent_profile_key")),
                context_package_id=_optional_string(public_input_mapping.get("context_package_id")),
                protocol_definition_id=_optional_string(public_input_mapping.get("protocol_definition_id")),
                protocol_binding_id=_optional_string(public_input_mapping.get("protocol_binding_id")),
                run_spec_id=_optional_string(public_input_mapping.get("run_spec_id")),
                capability_allowlist=list(public_input_mapping.get("capability_allowlist") or []),
                budget=dict(public_input_mapping.get("budget") or {}),
                output_contract={
                    "content_type": content_type,
                    "public_output_kind": type(public_output).__name__,
                },
                stop_conditions=list(public_input_mapping.get("stop_conditions") or []),
            )
        await self._sessions.record_trace(
            self._thread_id,
            str(active["id"]),
            "workflow.node.content",
            {
                "workflow_id": WORKFLOW_ID,
                "executor_id": executor_id,
                "actor": actor,
                "content_type": content_type,
                "public_input": public_input,
                "public_output": public_output,
                "step_input_projection": (
                    {
                        "id": projection["id"],
                        "revision": projection["projection_revision"],
                        "hash": projection["projection_hash"],
                    }
                    if projection is not None
                    else None
                ),
            },
        )


def _optional_string(value: Any) -> str | None:
    """把任意值收敛为去空白字符串；空串与非字符串归一为None，供可选引用字段使用。"""
    normalized = str(value or "").strip()
    return normalized or None


@dataclass(frozen=True, slots=True)
class ModelDispatchResult:
    """一次已治理Provider调用的解码文本及其持久化Attempt身份。"""

    text: str
    attempt_id: str


class IntakeExecutor(Executor, TraceMixin):
    """学习阶段S1、节点1 ``input_acceptance``：接纳本轮输入并建立Workflow初始状态。

    输入是AG-UI消息数组；输出是``CollaborationState``。这里取最后一条User文本作为
    ``origin_prompt``，召回近期TurnSummary和待回答澄清。完整消息历史仍由Product
    Session保存，Workflow只携带有界候选，避免每轮无界重放全部历史。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        intents: CollaborationIntentService,
    ) -> None:
        """节点1 input_acceptance：注入会话/治理/意图服务并固定executor_id；执行见@handler。"""

        super().__init__(id="input_acceptance")
        self._trace_init(thread_id=thread_id, sessions=sessions)
        self._governance = governance
        self._intents = intents

    @handler(input=list)
    # BP-09 触发：Workflow第一个业务节点（S1输入接纳）。用户在AG-UI发送消息后，
    # HTTP接纳层创建Runtime Job，Worker领取后启动主Workflow，第一个命中的业务节点就是这里。
    # 接收用户输入，把Prompt规范化为origin_prompt并构建初始CollaborationState。
    # 跨边界：HTTP接纳->Runtime Job->Worker->_execute_claim->Workflow的首个业务栈帧。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md
    async def accept(self, messages: list[Any], ctx: WorkflowContext[CollaborationState]) -> None:
        """S1输入接纳节点。用户在AG-UI发送消息后，HTTP接纳层创建Runtime Job，Worker领取后
        启动主Workflow，第一个命中的业务节点就是这里。

        接收AG-UI传来的messages列表，规范化为Provider可用格式，提取最后一条用户消息作为
        origin_prompt，拉取最近8轮TurnSummary和未关闭澄清，构建初始CollaborationState
        并发送给下一节点（CandidateContextExecutor）。

        跨边界：HTTP接纳->Runtime Job->Worker->_execute_claim->Workflow的首个业务栈帧。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-09
        # DEBUG-BREAKPOINT-NOTE: 触发: Workflow第一个业务节点（S1输入接纳）。
        # DEBUG-BREAKPOINT-NOTE: 触发: 接收用户输入，把Prompt规范化为origin_prompt并构建初始CollaborationState。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S1-输入接纳与目录级上下文。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每条用户消息触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-09
        normalized = normalize_agui_messages_for_provider(messages)
        user_messages = [value for value in normalized if value.get("role") == "user"]
        if not user_messages:
            raise ValueError("主Workflow没有收到用户输入")
        prompt = _message_text(user_messages[-1]).strip()
        if not prompt:
            raise ValueError("用户输入不能为空")
        summaries = await self._governance.recent_turn_summaries(self._thread_id, limit=8)
        pending_clarification = await self._intents.latest_open_clarification(self._thread_id)
        project_candidates = tuple(
            dict.fromkeys(hint for value in summaries if (hint := _project_hint(value)) is not None)
        )
        state = CollaborationState(
            origin_prompt=prompt,
            recent_turn_summaries=tuple(summaries),
            project_candidates=project_candidates,
            pending_clarification=pending_clarification,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="user",
            content_type="workflow_input",
            public_input=prompt,
            public_output={
                "accepted": True,
                "candidate_summary_count": len(summaries),
                "pending_clarification": pending_clarification,
                "note": "完整历史保留为证据；这里只把主题提取结果作为候选，不会无脑叠加历史。",
            },
        )
        await ctx.send_message(state)


class CandidateContextExecutor(Executor, TraceMixin):
    """学习阶段S1、节点2 ``context_candidates``：确定性召回最多4条主题候选。

    不调用模型。按Prompt与近期TurnSummary的关键词交集排序；待回答澄清优先。
    这里仅产生候选，是否采用仍由节点4的Context决定点控制。
    """

    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        """节点2 context_candidates：注入摘要召回依赖并固定executor_id；执行见@handler。"""

        super().__init__(id="context_candidates")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    # BP-10 触发：S1阶段的候选上下文筛选。在IntakeExecutor.accept之后、
    # HarnessDirectoryContextExecutor.assemble之前。根据用户输入关键词从历史TurnSummary中
    # 检索相关候选，优先带回未关闭澄清。
    # 跨边界：Workflow内部节点2，承接IntakeExecutor输出的CollaborationState。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md
    async def select_candidates(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """S1候选上下文筛选节点。在IntakeExecutor之后、HarnessDirectoryContextExecutor之前执行。

        根据origin_prompt提取关键词，对recent_turn_summaries做关键词命中打分；
        未关闭的澄清会优先保留，其余按命中分数降序最多取4条候选。结果写入Trace后
        将精简后的CollaborationState发送给HarnessDirectoryContextExecutor。

        跨边界：Workflow内部节点2，承接IntakeExecutor输出的CollaborationState。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-10
        # DEBUG-BREAKPOINT-NOTE: 触发: S1阶段的候选上下文筛选。
        # DEBUG-BREAKPOINT-NOTE: 触发: 根据用户输入从历史对话中检索相关候选。
        # DEBUG-BREAKPOINT-NOTE: 触发: 在BP-09之后、BP-11之前。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S1-输入接纳与目录级上下文。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每条用户消息触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-10
        keywords = _context_keywords(state.origin_prompt)
        scored: list[tuple[int, dict[str, Any]]] = []
        pending = [value for value in state.recent_turn_summaries if _is_pending_clarification(value)]
        for summary in state.recent_turn_summaries:
            if summary in pending:
                continue
            searchable = json.dumps(summary, ensure_ascii=False).lower()
            score = sum(1 for keyword in keywords if keyword in searchable)
            if score > 0:
                scored.append((score, summary))
        selected_values = pending[:1]
        selected_values.extend(
            value
            for _, value in sorted(scored, key=lambda item: item[0], reverse=True)
            if value not in selected_values
        )
        selected = tuple(selected_values[:4])
        next_state = replace(state, recent_turn_summaries=selected)
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_context_selector",
            content_type="context_candidates",
            public_input={
                "prompt": state.origin_prompt,
                "available_summaries": len(state.recent_turn_summaries),
            },
            public_output={
                "selected": list(selected),
                "selection_rule": (
                    "最近一条未回答澄清会优先带回；其余按关键词命中后最多采用4条候选。"
                    "最终采用仍由后续意图与HITL判断。"
                ),
            },
        )
        await ctx.send_message(next_state)


class HarnessDirectoryContextExecutor(Executor, TraceMixin):
    """学习阶段S1、节点3 ``harness_directory_context``：从Product Harness读取正式目录Context。

    输入是Prompt与节点2选中的摘要；输出是候选ContextPackage、正式Project候选和
    排除项。这里读取权威Product Store，不从聊天摘要猜Project是否存在。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        """节点3 harness_directory_context：注入Harness服务并固定executor_id；执行见@handler。"""

        super().__init__(id="harness_directory_context")
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    # BP-11 触发：S1阶段的目录上下文组装。在CandidateContextExecutor之后执行。
    # 把候选上下文、目录信息和Harness配置打包成ContextPackage，会调用
    # HarnessService.create_context_package先落库再进入HITL。
    # 跨边界：Workflow内部节点3，承接CandidateContextExecutor的候选摘要，调用HarnessService。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md
    async def assemble(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """S1目录上下文组装节点。在CandidateContextExecutor之后执行，把候选摘要与权威Project
        目录转换成ContextPackage。

        调用HarnessService.directory_context_items生成带来源、版本、采用原因和Token估算的
        Context Item，再经create_context_package先落库为candidate状态，使审批Hash和
        Checkpoint恢复绑定同一份可追溯Context，而非会丢失的Python变量。采用后的Item
        写入CollaborationState发送给下一节点审核。

        跨边界：Workflow内部节点3，承接CandidateContextExecutor的候选摘要，调用HarnessService。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-11
        # DEBUG-BREAKPOINT-NOTE: 触发: S1阶段的目录上下文组装。
        # DEBUG-BREAKPOINT-NOTE: 触发: 把候选上下文、目录信息、Harness配置打包成ContextPackage，供后续模型调用使用。
        # DEBUG-BREAKPOINT-NOTE: 触发: 会调用BP-20。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S1-输入接纳与目录级上下文。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每条用户消息触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-11
        items, projects = await self._harness.directory_context_items(
            prompt=state.origin_prompt,
            summaries=state.recent_turn_summaries,
        )
        package = await self._harness.create_context_package(
            session_id=self._thread_id,
            run_id=self._run_id(),
            stage="directory",
            items=items,
            token_budget=1800,
            status="candidate",
        )
        next_state = replace(
            state,
            project_matches=tuple(projects),
            context_items=tuple(item for item in package["items"] if item["adopted"]),
            directory_context_package_id=package["id"],
        )
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_query",
            content_type="context_directory",
            public_input={"prompt": state.origin_prompt, "summary_count": len(state.recent_turn_summaries)},
            public_output={
                "context_package_id": package["id"],
                "project_candidates": projects,
                "adopted_items": [item for item in package["items"] if item["adopted"]],
                "excluded_items": [item for item in package["items"] if not item["adopted"]],
            },
        )
        await ctx.send_message(next_state)


class HarnessProjectResolverExecutor(Executor, TraceMixin):
    """学习阶段S2、节点10 ``harness_project_resolver``：把已接受意图解析到正式Project。

    只有唯一名称匹配才自动绑定；零匹配和多匹配都保留为空并交给节点11。若本轮是
    Project目录查询，也在这里读取正式列表，避免后续模型编造目录事实。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        """节点10 harness_project_resolver：注入Harness服务并固定executor_id；执行见@handler。"""

        super().__init__(id="harness_project_resolver")
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def resolve(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点10：匹配Project提示、记录匹配数和需要人工选择的原因。"""
        hint = str((state.intent or {}).get("project_hint") or "").strip().lower()
        matches = [
            value
            for value in state.project_matches
            if hint
            and (
                hint in str(value.get("title") or "").lower() or str(value.get("title") or "").lower() in hint
            )
        ]
        selected = matches[0]["id"] if len(matches) == 1 else state.selected_project_id
        if len(matches) == 1:
            project_selection_reason = "Project提示唯一匹配正式目录，确定性绑定该Project。"
        elif state.selected_project_id:
            project_selection_reason = "沿用上游已经版本化确认的Project绑定。"
        elif not hint:
            project_selection_reason = "已接受Intent没有提供Project提示，本轮不猜测Project。"
        elif not matches:
            project_selection_reason = "Project提示在正式目录中零匹配，保持为空等待用户选择或澄清。"
        else:
            project_selection_reason = "Project提示命中多个正式Project，不能擅自选择。"
        catalog_requested = any(
            value.get("query_kind") == "project_catalog" for value in state.intents or ((state.intent or {}),)
        )
        catalog_result = state.project_catalog_result
        if catalog_requested:
            projects = await self._harness.list_projects(
                statuses=("proposed", "active", "paused", "completed"),
            )
            catalog_result = _render_project_catalog_result(
                projects,
                list(state.project_candidates),
            )
        next_state = replace(
            state,
            selected_project_id=selected,
            project_catalog_result=catalog_result,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_resolver",
            content_type="project_resolution",
            public_input={"project_hint": hint, "directory_candidates": list(state.project_matches)},
            public_output={
                "selected_project_id": selected,
                "match_count": len(matches),
                "requires_human_choice": state.scenario == "continue_project" and selected is None,
                "selection_reason": project_selection_reason,
                "project_catalog_result": catalog_result,
                "empty_reasons": {
                    **(
                        {
                            "selected_project_id": {
                                "code": "not_produced",
                                "reason": project_selection_reason,
                            }
                        }
                        if selected is None
                        else {}
                    ),
                    **(
                        {
                            "project_catalog_result": {
                                "code": "not_applicable",
                                "reason": "本轮Intent不是Project目录查询，没有读取目录结果正文。",
                            }
                        }
                        if catalog_result is None
                        else {}
                    ),
                },
            },
        )
        await ctx.send_message(next_state)


class HarnessDetailContextExecutor(Executor, TraceMixin):
    """学习阶段S2、节点12 ``harness_detail_context``：装配已绑定Project的有界工作集。

    未绑定Project时明确记录``not_applicable``；已绑定时加载开放Work、Plan、Action、
    Note、Accepted Memory、Repository Snapshot和治理规则，并受Token Budget限制。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        """节点12 harness_detail_context：注入Harness服务并固定executor_id；执行见@handler。"""

        super().__init__(id="harness_detail_context")
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def assemble(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点12：创建Context装配的detail步骤ContextPackage；空值原因也写入Trace。"""
        if state.selected_project_id is None:
            await self._trace_content(
                executor_id=self.id,
                actor="product_harness_query",
                content_type="context_detail",
                public_input={"selected_project_id": None},
                public_output={"status": "not_applicable", "reason": "本轮未绑定正式Project"},
            )
            await ctx.send_message(state)
            return
        items = await self._harness.detailed_context_items(
            state.selected_project_id,
            prompt=state.origin_prompt,
            scenario=state.scenario,
        )
        package = await self._harness.create_context_package(
            session_id=self._thread_id,
            run_id=self._run_id(),
            stage="detail",
            items=items,
            selected_project_id=state.selected_project_id,
            token_budget=6000,
            status="adopted",
        )
        adopted = tuple(item for item in package["items"] if item["adopted"])
        next_state = replace(
            state,
            context_items=adopted,
            detail_context_package_id=package["id"],
        )
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_query",
            content_type="context_detail",
            public_input={"selected_project_id": state.selected_project_id},
            public_output={
                "context_package_id": package["id"],
                "estimated_tokens": package["estimated_tokens"],
                "token_budget": package["token_budget"],
                "adopted_items": list(adopted),
                "excluded_items": [item for item in package["items"] if not item["adopted"]],
            },
        )
        await ctx.send_message(next_state)


def _state_with_context_package(
    state: CollaborationState,
    package: Mapping[str, Any],
    *,
    stage: str,
) -> CollaborationState:
    """把一个不可变ContextPackage revision投影回运行状态，不重新做召回。"""

    adopted = tuple(dict(value) for value in package["items"] if value["adopted"])
    next_state = replace(
        state,
        context_items=adopted,
        directory_context_package_id=(
            str(package["id"]) if stage == "directory" else state.directory_context_package_id
        ),
        detail_context_package_id=(
            str(package["id"]) if stage == "detail" else state.detail_context_package_id
        ),
    )
    if stage != "directory":
        return next_state
    adopted_summary_ids = {
        str(value["source_id"]) for value in adopted if value["source_kind"] == "turn_summary"
    }
    adopted_project_ids = {
        str(value["source_id"]) for value in adopted if value["source_kind"] == "project_directory"
    }
    return replace(
        next_state,
        recent_turn_summaries=tuple(
            value
            for value in state.recent_turn_summaries
            if str(value.get("id") or "") in adopted_summary_ids
        ),
        project_matches=tuple(
            value for value in state.project_matches if str(value.get("id") or "") in adopted_project_ids
        ),
    )


class HarnessContextRevisionExecutor(Executor, TraceMixin):
    """学习阶段S1/S2、节点5/14：把最新ContextPackage revision投影进Workflow。

    ``directory_context_revision``处理目录候选，``detail_context_revision``处理Project
    详情。该节点确保用户排除的Context不会继续残留在旧内存状态中。
    """

    def __init__(
        self,
        *,
        node_id: str,
        stage: str,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        """Context revision节点（5 directory / 14 detail）：节点号由``stage``参数决定；非法stage立即失败。"""

        super().__init__(id=node_id)
        if stage not in {"directory", "detail"}:
            raise ValueError(f"Unsupported Context stage: {stage}")
        self._stage = stage
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def project(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点5/14：读取当前Run同阶段最新revision，并公开采用/排除来源。"""
        package = await self._harness.context_package_for_run(
            run_id=self._run_id(),
            stage=self._stage,
        )
        if package is None:
            await ctx.send_message(state)
            return
        next_state = _state_with_context_package(
            state,
            package,
            stage=self._stage,
        )
        adopted = next_state.context_items
        await self._trace_content(
            executor_id=self.id,
            actor="product_context_projection",
            content_type="context_revision",
            public_input={
                "stage": self._stage,
                "context_package_id": package["id"],
                "revision": package["revision"],
            },
            public_output={
                "adopted_sources": [
                    {
                        "source_kind": value["source_kind"],
                        "source_id": value["source_id"],
                        "source_revision": value["source_revision"],
                        "title": value["title"],
                        "reason": value["reason"],
                    }
                    for value in adopted
                ],
                "excluded_sources": [
                    {
                        "source_kind": value["source_kind"],
                        "source_id": value["source_id"],
                        "source_revision": value["source_revision"],
                        "title": value["title"],
                        "reason": value["reason"],
                    }
                    for value in package["items"]
                    if not value["adopted"]
                ],
            },
        )
        await ctx.send_message(next_state)


class CollaborationProtocolResolverExecutor(Executor, TraceMixin):
    """学习阶段S2、节点15：绑定本轮不可变协作协议revision。

    解析在Intent和正式Project绑定后确定性执行，优先级为Work -> Project -> User ->
    System。选中的方法、阶段、规则、预算和原因进入Checkpoint、ExecutionDraft和Trace，
    后续模型不能静默换成另一套方法。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        collaboration_protocols: CollaborationProtocolService,
    ) -> None:
        """节点15 collaboration_protocol_resolver：注入协议服务并固定executor_id；执行见@handler。"""

        super().__init__(id="collaboration_protocol_resolver")
        self._protocols = collaboration_protocols
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def resolve(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点15：解析基础协议、叠加多Intent约束并固化有效选择Hash。"""
        intent = state.intent or {}
        selection = await self._protocols.resolve_for_turn(
            scenario=state.scenario,
            project_id=state.selected_project_id,
            query_kind=str(intent.get("query_kind") or "") or None,
        )
        selection = _apply_intent_set_protocol_overlay(
            selection,
            state.intents or (intent,),
        )
        next_state = replace(state, protocol_selection=selection)
        await self._trace_content(
            executor_id=self.id,
            actor="chat_harness_protocol_resolver",
            content_type="collaboration_protocol_selection",
            public_input={
                "scenario": state.scenario,
                "query_kind": intent.get("query_kind"),
                "selected_project_id": state.selected_project_id,
                "resolution_order": ["work_item", "project", "user", "system"],
                "protocol_definition_id": selection["definition_id"],
                "protocol_binding_id": selection["binding_id"],
                "protocol_key": selection["protocol_key"],
                "protocol_name": selection["protocol_name"],
                "protocol_revision": selection["revision"],
                "selection_source": selection["selection_source"],
                "selection_reason": selection["selection_reason"],
                "phases": selection["phases"],
                "applicable_rules": selection["applicable_rules"],
                "budget": {"token_budget": selection["context_policy"].get("default_token_budget")},
                "base_execution_policy": selection.get(
                    "base_execution_policy",
                    selection.get("execution_policy"),
                ),
                "effective_execution_policy": selection.get("execution_policy"),
                "composition_overlay": selection.get("composition_overlay"),
            },
            public_output={
                "protocol_key": selection["protocol_key"],
                "protocol_name": selection["protocol_name"],
                "revision": selection["revision"],
                "definition_id": selection["definition_id"],
                "binding_id": selection["binding_id"],
                "definition_hash": selection["definition_hash"],
                "selection_hash": selection["selection_hash"],
                "effective_selection_hash": selection.get(
                    "effective_selection_hash",
                    selection["selection_hash"],
                ),
                "selection_source": selection["selection_source"],
                "selection_reason": selection["selection_reason"],
                "phases": selection["phases"],
                "applicable_rules": selection["applicable_rules"],
                "base_execution_policy": selection.get(
                    "base_execution_policy",
                    selection.get("execution_policy"),
                ),
                "effective_execution_policy": selection.get("execution_policy"),
                "composition_overlay": selection.get("composition_overlay"),
            },
        )
        await ctx.send_message(next_state)


@dataclass(frozen=True, slots=True)
class ProductDecisionSpec:
    """一个HITL产品决定点的声明式规格。

    节点4/8/11/13/20/22/34/35/36共用同一Executor和持久化interrupt机制，仅通过本
    Spec定义适用条件、Subject、公开事实、可编辑字段、修改函数和是否允许跳过。
    """

    key: str
    subject_kind: str
    title: str
    description: str
    accept_action: str
    applicable: Callable[[CollaborationState], bool]
    subject: Callable[[CollaborationState], Any]
    facts: Callable[[CollaborationState], Mapping[str, Any]]
    editable_fields: Callable[[CollaborationState], list[dict[str, Any]]]
    revise: Callable[[CollaborationState, Mapping[str, Any]], CollaborationState]
    allow_skip: bool = False
    grant_kind: str | None = None


class ProductDecisionExecutor(Executor, RequestInfoMixin, TraceMixin):
    """学习阶段S1/S2/S3/S4/S6共用：持久化Policy评估，必要时interrupt。

    每次决定绑定当前Subject Hash和版本：不适用会写明原因，自动通过会记录Decision
    与一次性Grant，需要人工时创建HumanDecisionRequest并停在可恢复Checkpoint。
    """

    def __init__(
        self,
        *,
        node_id: str,
        spec: ProductDecisionSpec,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        harness: HarnessService | None = None,
        collaboration_contexts: CollaborationContextService | None = None,
    ) -> None:
        """通用决定点执行器：节点身份与行为差异全部由注入的``ProductDecisionSpec``决定（见``_decision_specs``）。"""

        super().__init__(id=node_id)
        self.spec = spec
        self._run_id = run_id
        self._governance = governance
        self._harness = harness
        self._collaboration_contexts = collaboration_contexts
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def decide(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        """节点入口：把当前CollaborationState送入统一的适用性与Policy判断。"""
        await self._advance(state, ctx)

    # BP-12 触发：产品决策节点（S6提交决定）。共用于S1/S2/S3/S4/S6多个决定点，
    # 不是只在模型调用之后执行。每次进入时登记Subject并走不适用、拒绝、自动继续或等待人工。
    # 跨边界：Workflow内部决策门，承接各语义Agent Executor或前置决策节点的CollaborationState。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S6-响应摘要与提交决定.md
    async def _advance(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        """产品决策推进。共用于S1/S2/S3/S4/S6多个决定点，不是只在模型调用之后执行。

        每次进入时先用spec.subject生成决策内容并登记Subject（execution_authorization
        分支复用已有Draft Revision）。随后检查适用性：不适用则record_not_applicable并
        放行；适用则评估Policy，在deny（关闭）、auto_continue（消费Grant直接放行）、
        等待人工（创建HumanDecisionRequest并触发MAF interrupt）四条路径中收敛。

        跨边界：Workflow内部决策门，承接各语义Agent Executor或前置决策节点的CollaborationState。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S6-响应摘要与提交决定.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-12
        # DEBUG-BREAKPOINT-NOTE: 触发: 产品决策节点（S6提交决定）。
        # DEBUG-BREAKPOINT-NOTE: 触发: 共用于S1/S2/S3/S4/S6多个决定点；每次进入时登记Subject并走不适用、拒绝、自动继续或等待人工。
        # DEBUG-BREAKPOINT-NOTE: 触发: 不是只在模型调用之后执行。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S6-响应摘要与提交决定。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个决策点触发1次，单Run可命中多次
        breakpoint()  # DEBUG-BREAKPOINT: BP-12
        content = self.spec.subject(state)
        facts = dict(self.spec.facts(state))
        run_context = await self._governance.run_context(self._run_id())
        subject_hash = _hash(content)
        if self.spec.key == "execution_authorization" and state.execution_draft_revision_id:
            subject = await self._governance.execution_draft_subject(state.execution_draft_revision_id)
        else:
            subject = await self._governance.register_subject(
                subject_kind=self.spec.subject_kind,
                resource_id=f"{self._run_id()}:{self.id}",
                resource_revision=subject_hash[:16],
                subject_content=content,
                session_id=str(run_context["session_id"]),
                interaction_id=run_context["interaction_id"],
                run_id=str(run_context["run_id"]),
                run_attempt_id=run_context["run_attempt_id"],
                workflow_definition_id=WORKFLOW_ID,
                workflow_version=WORKFLOW_VERSION,
                node_id=self.id,
                decision_view={
                    "title": self.spec.title,
                    "description": self.spec.description,
                    "content": content,
                    "editable_fields": self.spec.editable_fields(state),
                },
            )
        if not self.spec.applicable(state):
            clarification_pending = self.spec.key == "intent_binding" and state.scenario == "clarify"
            await self._governance.record_not_applicable(
                subject=subject,
                decision_point_key=self.spec.key,
                facts=facts,
                reason_code=(
                    "clarification_requires_new_user_input"
                    if clarification_pending
                    else "no_candidate_subject_this_turn"
                ),
            )
            await self._trace_decision(
                state,
                content,
                "not_applicable",
                "需要先取得用户回答，当前意图候选不能绑定"
                if clarification_pending
                else "本轮没有需要决定的对象",
            )
            await ctx.send_message(state)
            return
        scopes = [
            {"kind": "product_default", "ref_id": "*"},
            {"kind": "principal", "ref_id": self._governance.principal_id},
            {"kind": "product_session", "ref_id": self._thread_id},
            {"kind": "interaction", "ref_id": str(run_context["interaction_id"] or "")},
            {"kind": "run", "ref_id": self._run_id()},
            {"kind": "workflow_version", "ref_id": WORKFLOW_ID},
            {"kind": "workflow_node", "ref_id": self.id},
            {"kind": "scenario", "ref_id": state.scenario},
        ]
        evaluation, preview = await self._governance.evaluate_subject(
            subject=subject,
            decision_point_key=self.spec.key,
            scopes=scopes,
            facts=facts,
        )
        final_action = str(preview["final_action"])
        if final_action == "deny":
            await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="deny",
                grant_kind=None,
                binding_hash=subject.subject_hash,
            )
            await self._trace_decision(state, content, "denied", "HITL策略阻止继续")
            raise PermissionError(f"HITL策略阻止决策点: {self.spec.key}")
        if final_action == "auto_continue":
            record, grant = await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code=self.spec.accept_action,
                grant_kind=self.spec.grant_kind,
                binding_hash=subject.subject_hash,
            )
            if grant is not None:
                await self._consume_grant(grant.id, subject.subject_hash)
            if self.spec.key in {"work_state_commit", "memory_commit"}:
                state = replace(
                    state,
                    harness_decision_record_ids=state.harness_decision_record_ids + (record.id,),
                )
            await self._trace_decision(state, content, "auto_continue", "按有效策略自动通过")
            await ctx.send_message(state)
            return
        allowed_actions = [self.spec.accept_action]
        if self.spec.editable_fields(state):
            allowed_actions.append("revise")
        if self.spec.allow_skip:
            allowed_actions.append("skip")
        allowed_actions.append("cancel")
        request = await self._governance.create_human_request(
            evaluation=evaluation,
            subject=subject,
            decision_point_key=self.spec.key,
            title=self.spec.title,
            reason="当前有效HITL策略要求用户确认后继续。",
            evidence={
                "workflow_node_id": self.id,
                "content": content,
                "facts": facts,
                "policy": preview,
            },
            consequence={
                self.spec.accept_action: "接受当前版本并继续Workflow。",
                "revise": "修改后形成新Subject Hash并重新评估。",
                "skip": "本轮跳过该候选，不写长期事实。",
                "cancel": "停止当前Run，不继续后续模型或工具调用。",
            },
            allowed_actions=allowed_actions,
        )
        card = {
            "review_kind": "product_decision",
            "message": self.spec.description,
            "approval_id": request.id,
            "decision_request_id": request.id,
            "decision_item_key": subject.id,
            "decision_point_key": self.spec.key,
            "title": self.spec.title,
            "reason_summary": request.reason_summary,
            "request_hash": request.request_hash,
            "row_version": request.row_version,
            "subject_hash": subject.subject_hash,
            "subject_resource_id": subject.resource_id,
            "subject": content,
            "facts": facts,
            "policy": preview,
            "allowed_actions": allowed_actions,
            "editable_fields": self.spec.editable_fields(state),
            "execution_context": {
                "workflow_id": WORKFLOW_ID,
                "workflow_version": WORKFLOW_VERSION,
                "executor_id": self.id,
                "workflow_state": asdict(state),
                "wait_reason": "product_decision",
            },
        }
        await self._sessions.mark_waiting_approval(self._thread_id, approval_id=request.id)
        await self._trace_decision(state, content, "waiting_human", "等待用户决定")
        await ctx.request_info(card, dict, request_id=request.id)

    async def _consume_grant(self, grant_id: str, binding_hash: str) -> None:
        """原子消费一次性Grant：幂等键绑定Run/节点/BindingHash，重复Resume或并发领取不会二次消费。"""

        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="workflow_decision",
            consumer_id=f"{self._run_id()}:{self.id}",
            idempotency_key=f"workflow-decision:{self._run_id()}:{self.id}:{binding_hash}",
            claimed_by=f"api-pid-{os.getpid()}:{self.id}",
        )
        if self.spec.key == "execution_authorization":
            await self._governance.bind_execution_authorization(
                run_id=self._run_id(),
                consumption_id=consumption.id,
            )

    async def _trace_decision(
        self,
        state: CollaborationState,
        content: Any,
        status: str,
        reason: str,
    ) -> None:
        """把决定结果（not_applicable/auto/human/skipped/deny）及原因写入Product Trace，供双报告还原。"""

        await self._trace_content(
            executor_id=self.id,
            actor="execution_governance",
            content_type="product_decision",
            public_input=content,
            public_output={
                "decision_point_key": self.spec.key,
                "status": status,
                "reason": reason,
                "scenario": state.scenario,
            },
        )

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        """恢复入口：校验版本绑定的用户决定，处理修改/跳过/取消/接受后继续。"""
        state_value = original_request.get("execution_context", {}).get("workflow_state")
        if not isinstance(state_value, dict):
            raise RuntimeError("产品决定请求缺少Workflow状态")
        state = _state_from_snapshot(state_value)
        action = str(decision.get("decision") or "")
        context_state: CollaborationState | None = None
        if decision.get("decision_recorded") is True:
            [resolved] = await self._governance.resolved_human_request(
                str(original_request["decision_request_id"])
            )
            if resolved["decision"] != action:
                raise GovernanceConflict("Outbox决定与MAF Resume payload不一致")
        else:
            resolved = await self._governance.resolve_single_human_request(
                request_id=str(original_request["decision_request_id"]),
                expected_request_hash=str(original_request["request_hash"]),
                expected_row_version=int(original_request["row_version"]),
                decision=action,
            )
        context_state = await self._revise_directory_context_if_needed(
            state=state,
            action=action,
            decision=decision,
            request_id=str(original_request["decision_request_id"]),
        )
        if action == "revise":
            if context_state is not None:
                await self._advance(context_state, ctx)
                return
            changes = decision.get("changes")
            if not isinstance(changes, Mapping):
                raise ValueError("修改决定必须提供结构化changes")
            await self._advance(self.spec.revise(state, changes), ctx)
            return
        if action == "skip":
            await self._trace_decision(state, self.spec.subject(state), "skipped", "用户本轮跳过")
            if context_state is not None:
                await ctx.send_message(context_state)
                return
            changes: Mapping[str, Any] = {"skip": True}
            await ctx.send_message(self.spec.revise(state, changes))
            return
        if action == "cancel":
            await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("当前Run已按用户决定停止，后续模型请求没有发送。")
            return
        if action != self.spec.accept_action:
            raise ValueError(f"不支持的产品决定: {action}")
        grant_id = resolved.get("authorization_grant_id")
        if grant_id:
            await self._consume_grant(str(grant_id), str(resolved["binding_hash"]))
        if self.spec.key in {"work_state_commit", "memory_commit"} and resolved.get("decision_record_id"):
            state = replace(
                state,
                harness_decision_record_ids=(
                    state.harness_decision_record_ids + (str(resolved["decision_record_id"]),)
                ),
            )
        await self._trace_decision(state, self.spec.subject(state), "accepted", "用户接受当前版本")
        await ctx.send_message(state)

    async def _revise_directory_context_if_needed(
        self,
        *,
        state: CollaborationState,
        action: str,
        decision: Mapping[str, Any],
        request_id: str,
    ) -> CollaborationState | None:
        """在Checkpoint前进前先持久化Context修改/跳过（仅context_adoption节点）。

        Checkpoint包含精确的package revision；重试按ID读该revision并重放同一确定性命令——
        即使首次尝试在进程丢失前已提交新revision，也不会双写。其他节点或其他动作直接返回None。
        """

        if self.id != "context_adoption" or action not in {"revise", "skip"}:
            return None
        if self._harness is None or self._collaboration_contexts is None:
            raise RuntimeError("Context决定缺少Harness应用协调依赖")
        package_id = state.directory_context_package_id
        if package_id is None:
            raise GovernanceConflict("Context决定缺少绑定的ContextPackage")
        package = await self._harness.context_package_by_id(package_id)
        if package is None:
            raise GovernanceConflict("ContextPackage已不存在，请重新准备本轮")
        changes = decision.get("changes")
        if action == "revise":
            if not isinstance(changes, Mapping):
                raise ValueError("修改决定必须提供结构化changes")
            selected = changes.get("selected_summary_ids")
            if not isinstance(selected, list) or not all(isinstance(value, str) for value in selected):
                raise ValueError("Context修改必须提供selected_summary_ids")
            selected_ids = set(selected)
        else:
            selected_ids = set()
        item_changes: list[dict[str, Any]] = []
        for item in package["items"]:
            desired = (
                False
                if action == "skip"
                else (
                    str(item["source_id"]) in selected_ids
                    if item["source_kind"] == "turn_summary"
                    else bool(item["adopted"])
                )
            )
            if desired == bool(item["adopted"]):
                continue
            item_changes.append(
                {
                    "ordinal": int(item["ordinal"]),
                    "adopted": desired,
                    "reason": (
                        "用户在Workflow中跳过本轮目录Context"
                        if action == "skip"
                        else "用户在Workflow中调整采用的回合重点"
                    ),
                }
            )
        if not item_changes:
            raise ValueError("Context没有发生变化；如无需修改请直接接受")
        revised = await self._collaboration_contexts.revise_package(
            package_id=package["id"],
            command_id=f"workflow-context:{request_id}:{action}",
            expected_package_hash=package["package_hash"],
            reason=(
                "用户在Workflow决定点跳过本轮目录Context"
                if action == "skip"
                else "用户在Workflow决定点修改本轮目录Context"
            ),
            item_changes=item_changes,
        )
        return _state_with_context_package(state, revised, stage="directory")


class GovernedSemanticAgentExecutor(Executor, RequestInfoMixin, TraceMixin):
    """学习阶段S2/S3/S6、节点6/19/32/33共用的受治理语义Agent执行器。

    分别承担意图识别、计划、答复和TurnSummary。每次调用都先持久化ModelCallDraft与
    Policy评估；只有版本绑定的批准或有效自动策略才能消费Grant并发送Provider。
    返回文本只成为对应候选，不能直接写Product长期事实。
    """

    def __init__(
        self,
        *,
        profile: AgentProfileSnapshot,
        node_id: str,
        call_ordinal: int,
        thread_id: str,
        run_id: Callable[[], str],
        store: InMemoryModelCallReviewStore,
        transport: ProviderTransport,
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        task_builder: Callable[[CollaborationState], str],
        result_kind: str,
        repository_freshness: RepositorySourceFreshnessGuard | None = None,
    ) -> None:
        """受治理语义Agent执行器：4个模型节点（6意图/19规划/32答复/33摘要）复用本类，差异由``result_kind``与``task_builder``决定。"""

        super().__init__(id=node_id)
        self.profile = profile
        self.call_ordinal = call_ordinal
        self._run_id = run_id
        self._store = store
        self._transport = transport
        self._governance = governance
        self._task_builder = task_builder
        self._result_kind = result_kind
        self._repository_freshness = repository_freshness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @property
    def description(self) -> str:
        """MAF要求的节点描述；直接取自版本化Agent Profile快照，保证与审批/审计同源。"""

        return self.profile.description

    def _begin(self, state: CollaborationState) -> ModelCallDraft:
        """按本节点任务构造第1版ModelCallDraft；此时还没有发送Provider。

        task_builder分别编译意图/计划/答复/摘要请求。``store=False``只显式装配本轮
        采用的上下文，不把完整历史交给Provider托管。
        """
        task = self._task_builder(state)
        context_package_id = state.detail_context_package_id or state.directory_context_package_id
        return self._store.begin(
            thread_id=self._thread_id,
            run_id=self._run_id(),
            messages=[{"role": "user", "content": task}],
            model=self.profile.model,
            provider_id=self.profile.provider_id,
            instructions=self.profile.instructions,
            origin_prompt=state.origin_prompt,
            execution_context={
                "workflow_id": WORKFLOW_ID,
                "workflow_version": WORKFLOW_VERSION,
                "executor_id": self.id,
                "agent_id": self.profile.id,
                "agent_name": self.profile.name,
                "agent_revision": self.profile.revision,
                "call_ordinal": self.call_ordinal,
                "scenario": state.scenario,
                "prompt_assembly": "selective-context-v1",
                "context_package_id": context_package_id,
                "repository_source_revisions": [
                    {
                        "source_kind": value.get("source_kind"),
                        "source_id": value.get("source_id"),
                        "source_revision": value.get("source_revision"),
                        "title": value.get("title"),
                        "adoption_reason": value.get("reason"),
                    }
                    for value in state.context_items
                    if str(value.get("source_kind") or "").startswith("repository_")
                    or (
                        value.get("source_kind") == "user_override"
                        and ":" in str(value.get("source_id") or "")
                    )
                ],
            },
        )

    @handler(input=CollaborationState)
    # BP-13 触发：语义Agent Executor入口（S2/S3/S4）。先检查确定性短路
    # （如目录查询命中is_project_catalog_query则不调用模型直接形成Intent）；其他路径才
    # 构造ModelCallDraft并进入Policy/审批/Provider治理。用户在前端看到的'模型调用审批'起点就在这里。
    # 跨边界：Workflow内部语义节点入口，承接ScenarioRouter或前置决策节点的CollaborationState。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S2-意图Project绑定与详情上下文.md
    async def prepare(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        """语义Agent Executor入口（S2/S3/S4）。先检查确定性短路，否则建立Draft并进入治理流程。

        明确的“列出项目”在意图节点直接形成目录Intent（0模型调用），不经Provider；
        其他请求才构造ModelCallDraft，经_begin建立后交给_advance进入Policy评估、
        审批或自动继续，最终到Provider。用户在前端看到的“模型调用审批”起点就在这里。

        跨边界：Workflow内部语义节点入口，承接ScenarioRouter或前置决策节点的CollaborationState。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S2-意图Project绑定与详情上下文.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-13
        # DEBUG-BREAKPOINT-NOTE: 触发: 语义Agent Executor入口（S2/S3/S4）。
        # DEBUG-BREAKPOINT-NOTE: 触发: 先检查确定性短路（如目录查询，命中BP-21则不调用模型）；其他路径才构造ModelCallDraft并进入Policy/审批/Provider治理。
        # DEBUG-BREAKPOINT-NOTE: 触发: 用户在前端看到的'模型调用审批'起点就在这里。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S2-意图Project绑定与详情上下文。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每次语义Agent节点调用1次；不等于每次都调用Provider
        breakpoint()  # DEBUG-BREAKPOINT: BP-13
        if self._result_kind == "intent" and _is_project_catalog_query(state.origin_prompt):
            intent = _project_catalog_intent(state.origin_prompt)
            await self._trace_content(
                executor_id=self.id,
                actor="deterministic_intent_guard",
                content_type="intent",
                public_input={"origin_prompt": state.origin_prompt},
                public_output={
                    **intent,
                    "execution_mode": "deterministic_guard",
                    "model_call_count": 0,
                    "reason": "明确的Product目录查询直接进入权威查询分支",
                },
            )
            await ctx.send_message(
                replace(
                    state,
                    intent=intent,
                    intents=(intent,),
                    scenario=str(intent["scenario"]),
                )
            )
            return
        await self._advance(self._begin(state), state, ctx)

    # BP-14 触发：ModelCallDraft治理推进。Draft建立后立即进入：检查Context新鲜度、
    # 登记治理对象、评估Policy，然后分deny、auto_continue或MAF人工中断。
    # 修订后的新Draft也会再次进入；人工批准后的resolve可直接dispatch。
    # 跨边界：Workflow内部治理分叉，承接prepare或修订路径的ModelCallDraft。
    # 对应文档：项目掌握/协作理解与执行治理/ExecutionDraft-RunSpec-HITL-Decision与Grant怎样连接.md
    async def _advance(
        self,
        draft: ModelCallDraft,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        """ModelCallDraft治理推进。Draft建立后立即进入：检查Context新鲜度、登记治理对象、
        评估Policy，然后分deny、auto_continue或MAF人工中断。

        先调用_require_fresh_context检查Repository新鲜度并持久化评估结果；deny则关闭本轮，
        auto_continue消费已有Grant直接dispatch，其余创建HumanDecisionRequest并触发MAF
        interrupt等待人工。审核卡携带状态快照供Checkpoint恢复；修订后的新Draft也会再次
        进入此方法；人工批准后的resolve可直接dispatch到Provider。

        跨边界：Workflow内部治理分叉，承接prepare或修订路径的ModelCallDraft。
        对应文档：项目掌握/协作理解与执行治理/ExecutionDraft-RunSpec-HITL-Decision与Grant怎样连接.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-14
        # DEBUG-BREAKPOINT-NOTE: 触发: ModelCallDraft治理推进。
        # DEBUG-BREAKPOINT-NOTE: 触发: Draft建立后立即进入：检查Context新鲜度、登记治理对象、评估Policy，然后分deny、auto_continue或MAF人工中断。
        # DEBUG-BREAKPOINT-NOTE: 触发: 修订后的新Draft也会再次进入；人工批准后的resolve可直接dispatch。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：ExecutionDraft-RunSpec-HITL-Decision与Grant怎样连接。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个ModelCallDraft revision推进时触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-14
        freshness = await self._require_fresh_context(
            state,
            phase="draft_prepare",
        )
        card = draft.review_card()
        effective_context = card.get("effective_context")
        if isinstance(effective_context, dict):
            sources = self._knowledge_sources(state)
            effective_context["knowledge_sources"] = sources
            adoption_reasons = effective_context.get("adoption_reasons")
            if isinstance(adoption_reasons, dict):
                adoption_reasons["history_and_knowledge"] = (
                    "消息数组与独立Context来源都从同一Provider请求草稿派生；每个来源公开采用原因和版本"
                )
                adoption_reasons["knowledge_sources"] = (
                    "本轮明确采用的Project、Repository、规则、摘要、笔记与Memory；正文已实际编入当前任务消息"
                )
        execution_context = card.setdefault("execution_context", {})
        if isinstance(execution_context, dict):
            execution_context["context_freshness"] = freshness
        slot, revision, evaluation, preview, request = await self._governance.register_model_call(
            review_card=card
        )
        governance_view = {
            "model_call_slot_id": slot.id,
            "model_call_revision_id": revision.id,
            "policy_evaluation_id": evaluation.id,
            "final_action": preview["final_action"],
            "reason_codes": preview["reason_codes"],
            "matched_rules": preview["matched_rules"],
            "decision_request_id": request.id if request else None,
            "decision_request_hash": request.request_hash if request else None,
            "decision_request_row_version": request.row_version if request else None,
            "decision_item_key": revision.subject_id if request else None,
        }
        if isinstance(execution_context, dict):
            execution_context["governance"] = governance_view
        await self._trace_content(
            executor_id=self.id,
            actor=self.profile.name,
            content_type="model_call_draft",
            public_input={
                "task": self._task_builder(state),
                "selected_turn_summaries": list(state.recent_turn_summaries),
                "agent_profile_key": self.profile.id,
                "context_package_id": (state.detail_context_package_id or state.directory_context_package_id),
                "context_sources": self._knowledge_sources(state),
                "protocol_definition_id": ((state.protocol_selection or {}).get("definition_id")),
                "protocol_binding_id": ((state.protocol_selection or {}).get("binding_id")),
                "run_spec_id": state.run_spec_id,
                "capability_allowlist": [],
                "budget": {
                    "token_budget": (
                        (state.protocol_selection or {}).get("context_policy", {}).get("default_token_budget")
                    ),
                    "model_calls": 1,
                },
                "stop_conditions": [
                    "模型调用必须先通过当前ModelCallDraft授权",
                    "结构输出无效时关闭失败，不猜测状态",
                ],
            },
            public_output={
                "model_call_revision_id": revision.id,
                "policy_action": preview["final_action"],
                "status": "等待用户确认" if request else "按策略处理",
            },
        )
        if preview["final_action"] == "deny":
            await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=await self._subject(revision.subject_id),
                decision_code="deny",
                grant_kind=None,
                binding_hash=revision.binding_hash,
            )
            raise PermissionError("当前HITL策略禁止本次模型调用")
        if preview["final_action"] == "auto_continue":
            subject = await self._subject(revision.subject_id)
            _, grant = await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="approve",
                grant_kind="send_model_call",
                binding_hash=revision.binding_hash,
            )
            if grant is None:
                raise RuntimeError("自动模型调用决定没有签发授权")
            dispatched = await self._dispatch(
                draft,
                revision,
                grant_id=grant.id,
                binding_hash=revision.binding_hash,
                state=state,
                request_id=None,
            )
            if dispatched is not None:
                await self._deliver(dispatched, state, revision.id, ctx)
            return
        if request is None:
            raise RuntimeError("人工模式没有创建Human Decision Request")
        await self._sessions.mark_waiting_approval(
            self._thread_id,
            draft_id=draft.draft_id,
            approval_id=draft.approval_id,
        )
        await self._request_review_with_state(card, state, ctx)

    async def _subject(self, subject_id: str):
        """按ID读取持久ModelCall DecisionSubject；恢复路径不容忍悬空引用，缺失即失败。"""

        from ..governance.models import DecisionSubjectRecord

        async with self._governance.database.sessions() as transaction:
            value = await transaction.get(DecisionSubjectRecord, subject_id)
            if value is None:
                raise RuntimeError("ModelCall DecisionSubject不存在")
            return value

    async def _dispatch(
        self,
        draft,
        revision,
        *,
        grant_id: str,
        binding_hash: str,
        state: CollaborationState,
        request_id: str | None,
    ) -> ModelDispatchResult | None:
        """把已批准的精确字节发送Provider并记录一次ModelCall Attempt。

        发送前再次检查Repository围栏；进程内Claim保证单Owner，重复Resume不会重发。
        取消时若无法证明Provider未收到请求，收敛为``outcome_unknown``而不是自动重试。
        """
        await self._require_fresh_context(
            state,
            phase="provider_dispatch",
            revision_id=revision.id,
            request_id=request_id,
        )
        try:
            await self._sessions.mark_running(self._thread_id)
            claimed = self._store.claim(
                approval_id=draft.approval_id,
                expected_hash=draft.binding_hash,
                owner=f"api-pid-{os.getpid()}:{self.id}",
            )
        except ModelCallDraftConflict:
            return None
        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="model_call_attempt",
            consumer_id=revision.id,
            idempotency_key=f"model-call:{revision.id}",
            claimed_by=f"api-pid-{os.getpid()}:{self.id}",
        )
        attempt = await self._governance.start_model_call_attempt(
            revision=revision,
            consumption=consumption,
        )
        chunks: list[str] = []
        dispatch_started = False

        async def report_provider_stage(
            stage: str,
            status: str,
            details: dict[str, Any],
        ) -> None:
            nonlocal dispatch_started
            starts_dispatch = stage == "provider.dispatch" and status == "in_progress"
            try:
                await self._governance.record_model_call_transport_event(
                    attempt_id=attempt.id,
                    stage=stage,
                    status=status,
                    details=details,
                )
            except Exception as error:
                raise ProviderDispatchError(
                    "模型调用审计写入失败，已停止继续处理Provider结果。",
                    error_code="model_call_audit_failed",
                    outcome_status="outcome_unknown" if dispatch_started else "failed",
                ) from error
            if starts_dispatch:
                dispatch_started = True

        try:
            prepared = PreparedProviderRequest.from_draft(
                claimed,
                stage_reporter=report_provider_stage,
            )
            async for text in self._transport.stream(prepared):
                chunks.append(text)
        except ProviderDispatchError as error:
            self._store.mark_attempt(draft.approval_id, error.outcome_status, error_code=error.error_code)
            await self._governance.finish_model_call_attempt(
                attempt_id=attempt.id,
                status=error.outcome_status,
                failure_code=error.error_code,
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status=error.outcome_status,
                error_code=error.error_code,
                message=str(error),
            )
            raise
        except asyncio.CancelledError:
            self._store.mark_attempt(
                draft.approval_id, "outcome_unknown", error_code="provider_dispatch_cancelled"
            )
            await self._governance.finish_model_call_attempt(
                attempt_id=attempt.id,
                status="outcome_unknown",
                failure_code="provider_dispatch_cancelled",
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status="outcome_unknown",
                error_code="provider_dispatch_cancelled",
                message="Provider发送期间被取消，结果未知。",
            )
            raise
        self._store.mark_attempt(draft.approval_id, "completed")
        decoded_text = "".join(chunks)
        await self._governance.finish_model_call_attempt(
            attempt_id=attempt.id,
            status="completed",
            output_text=decoded_text,
        )
        return ModelDispatchResult(
            text=decoded_text or "模型调用已完成，但没有返回可显示的文本。",
            attempt_id=attempt.id,
        )

    def _knowledge_sources(self, state: CollaborationState) -> list[dict[str, Any]]:
        """把本轮采用Context投影为Provider请求的知识来源字段。

        摘要任务只给来源引用（``reference_only``，不回放正文）；其他任务给采用项正文与Token
        估算。这是“每轮最小充分上下文”的物化点，审批视图与真实请求共用同一份投影。
        """

        if self._result_kind == "summary":
            return [
                {
                    "source_type": value["kind"],
                    "source_id": value["id"],
                    "source_revision": value.get("revision"),
                    "source_label": value.get("title"),
                    "adoption_reason": value.get("adoption_reason"),
                    "selection_origin": value.get("selection_origin"),
                    "modified_in_review": value["kind"] == "user_override",
                    "content_mode": "reference_only",
                }
                for value in _context_source_references(state.context_items)
            ]
        return [
            {
                "source_type": value.get("source_kind"),
                "source_id": value.get("source_id"),
                "source_revision": value.get("source_revision"),
                "source_label": value.get("title"),
                "adoption_reason": value.get("reason"),
                "selection_origin": value.get("selection_origin"),
                "modified_in_review": value.get("source_kind") == "user_override",
                "token_estimate": value.get("token_estimate"),
                "content": value.get("content"),
            }
            for value in state.context_items
            if value.get("adopted", True)
        ]

    async def _require_fresh_context(
        self,
        state: CollaborationState,
        *,
        phase: str,
        revision_id: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Repository来源新鲜度门：草稿准备、审批与Provider发送前复核ContextPackage引用的Snapshot。

        过期时让旧授权失效、把当前Run失败关闭为``context_source_stale``并提示“按最新仓库重新
        准备”，Provider Attempt保持0；未配置Repository Guard时直通（如纯聊天Session）。
        """

        package_id = state.detail_context_package_id or state.directory_context_package_id
        if self._repository_freshness is None:
            return {
                "fresh": True,
                "context_package_id": package_id,
                "sources": [],
                "guard": "not_configured",
            }
        try:
            report = await self._repository_freshness.assert_package_fresh(package_id)
        except ContextSourceStale as error:
            logger.warning(
                "repository_context_gate phase=%s context_package_id=%s result=stale reason_code=%s",
                phase,
                package_id,
                error.reason_code,
            )
            if revision_id is not None:
                await self._governance.invalidate_model_call_source(
                    revision_id=revision_id,
                    request_id=request_id,
                    reason_code=error.code.lower(),
                )
            await self._trace_content(
                executor_id=self.id,
                actor="context_source_freshness_guard",
                content_type="context_source_freshness",
                public_input={
                    "phase": phase,
                    "context_package_id": package_id,
                },
                public_output={
                    "status": "stale",
                    "error_code": error.code.lower(),
                    "reason_code": error.reason_code,
                    "recovery_actions": ["reprepare", "stop"],
                },
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status="failed",
                error_code=error.code.lower(),
                message=("仓库上下文已变化，旧请求未发送。请按最新仓库重新准备，或停止本轮。"),
            )
            raise
        logger.info(
            "repository_context_gate phase=%s context_package_id=%s result=fresh sources=%d",
            phase,
            package_id,
            len(report.get("sources") or []),
        )
        await self._trace_content(
            executor_id=self.id,
            actor="context_source_freshness_guard",
            content_type="context_source_freshness",
            public_input={
                "phase": phase,
                "context_package_id": package_id,
            },
            public_output={
                "status": "fresh",
                "source_count": len(report.get("sources") or []),
                "source_revisions": [
                    {
                        "binding_id": value.get("binding_id"),
                        "semantic_hash": value.get("semantic_hash"),
                        "snapshot_sequence": value.get("snapshot_sequence"),
                    }
                    for value in report.get("sources") or []
                ],
            },
        )
        return {**report, "guard": "repository_source_freshness_v1"}

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        """模型审批恢复入口：接受、修改重审或放弃，并只恢复对应Draft。"""
        # A restored MAF Checkpoint contains the exact review card, while the
        # transport claim registry is intentionally process-local. Rehydrate
        # it from the hash-verified card before applying the durable decision.
        restored_draft = self._store.restore_review_card(original_request)
        state_value = original_request.get("execution_context", {}).get("workflow_state")
        if not isinstance(state_value, dict):
            raise RuntimeError("审批请求缺少Workflow状态快照")
        state = _state_from_snapshot(state_value)
        governance_view = original_request.get("execution_context", {}).get("governance")
        if not isinstance(governance_view, dict):
            raise RuntimeError("审批请求缺少持久治理引用")
        request_id = str(governance_view.get("decision_request_id") or "")
        request_hash = str(governance_view.get("decision_request_hash") or "")
        row_version = int(governance_view.get("decision_request_row_version") or 0)
        action = decision.get("decision")
        pre_recorded: dict[str, Any] | None = None
        if decision.get("decision_recorded") is True:
            [pre_recorded] = await self._governance.resolved_human_request(request_id)
            if pre_recorded["decision"] != action:
                raise GovernanceConflict("Outbox决定与MAF Resume payload不一致")
        if action == "revise":
            if pre_recorded is None:
                await self._governance.resolve_single_human_request(
                    request_id=request_id,
                    expected_request_hash=request_hash,
                    expected_row_version=row_version,
                    decision="revise",
                )
            revised = self._store.successor(
                str(original_request["draft_id"]),
                str(decision["revision_draft_id"]),
            )
            await self._advance(revised, state, ctx)
            return
        if action == "abandon":
            if pre_recorded is None:
                await self._governance.resolve_single_human_request(
                    request_id=request_id,
                    expected_request_hash=request_hash,
                    expected_row_version=row_version,
                    decision="abandon",
                )
            self._store.abandon(str(original_request["approval_id"]))
            await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("本次主Workflow已放弃，当前模型请求没有发送。")
            return
        if action != "approve":
            raise ValueError(f"不支持的模型调用决定: {action}")
        revision_id = str(governance_view.get("model_call_revision_id") or "")
        from ..governance.models import ModelCallDraftRevisionRecord

        async with self._governance.database.sessions() as transaction:
            revision = await transaction.get(ModelCallDraftRevisionRecord, revision_id)
            if revision is None:
                raise RuntimeError("持久ModelCall revision不存在")
        await self._require_fresh_context(
            state,
            phase="approval",
            revision_id=revision.id,
            request_id=request_id,
        )
        resolved = pre_recorded or await self._governance.resolve_single_human_request(
            request_id=request_id,
            expected_request_hash=request_hash,
            expected_row_version=row_version,
            decision="approve",
        )
        grant_id = str(resolved.get("authorization_grant_id") or "")
        draft = restored_draft
        dispatched = await self._dispatch(
            draft,
            revision,
            grant_id=grant_id,
            binding_hash=str(resolved["binding_hash"]),
            state=state,
            request_id=request_id,
        )
        if dispatched is None:
            await ctx.yield_output("该授权已失效或已消费，没有重复发送模型请求。")
            return
        await self._deliver(dispatched, state, revision.id, ctx)

    # BP-15 触发：Provider返回结果的交付点。模型返回结果后，把结果交给产品层：
    # 写Trace、更新状态、准备下一步。
    # 跨边界：Provider->Workflow的交付栈帧，承接_advance或resolve dispatch后的ModelDispatchResult。
    # 对应文档：项目掌握/Trace与可观测性/每轮双Trace如何保存、分析与可视化.md
    async def _deliver(
        self,
        dispatched: ModelDispatchResult,
        state,
        revision_id,
        ctx,
    ) -> None:
        """Provider返回结果的交付点。模型返回结果后，把结果交给产品层：写Trace、更新状态、准备下一步。

        意图输出解析为Intent Set（非法JSON关闭失败为澄清）；plan/response原文存放；摘要先解析
        再经写回策略过滤，违反用户只读边界的Work/Memory候选在到达决定点前就被确定性移除。
        采用去向（accepted/overridden/rejected_invalid_output）持久化在Attempt上，审计链能
        精确说明这些字节后来被怎样使用。模型文字此时还不是产品事实，只作为候选推进到下游决策门。

        跨边界：Provider->Workflow的交付栈帧，承接_advance或resolve dispatch后的ModelDispatchResult。
        对应文档：项目掌握/Trace与可观测性/每轮双Trace如何保存、分析与可视化.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-15
        # DEBUG-BREAKPOINT-NOTE: 触发: Provider返回结果的交付点。
        # DEBUG-BREAKPOINT-NOTE: 触发: 模型返回结果后，把结果交给产品层：写Trace、更新状态、准备下一步。
        # DEBUG-BREAKPOINT-NOTE: 触发: 这是模型调用的收尾步骤。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：每轮双Trace如何保存、分析与可视化。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每次成功的模型调用触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-15
        text = dispatched.text
        disposition = f"accepted_as_{self._result_kind}"
        disposition_reason = f"Provider解码文本已由{self.id}作为{self._result_kind}采用"
        if self._result_kind == "intent":
            parsed = _json_object(text)
            if _is_project_catalog_query(state.origin_prompt):
                candidates = (_project_catalog_intent(state.origin_prompt),)
                disposition = "overridden_by_deterministic_guard"
                disposition_reason = "恢复旧Checkpoint时命中明确项目清单查询，模型候选未被采用"
            else:
                candidates = _normalize_intent_candidates(
                    parsed,
                    origin_prompt=state.origin_prompt,
                )
            pending_id = str((state.pending_clarification or {}).get("id") or "")
            candidates = tuple(
                {
                    **candidate,
                    "answers_clarification_id": (
                        pending_id
                        if pending_id and candidate.get("answers_clarification_id") == pending_id
                        else None
                    ),
                }
                for candidate in candidates
            )
            if (
                len(candidates) == 1
                and candidates[0]["scenario"] == "clarify"
                and float(candidates[0].get("confidence") or 0) == 0
            ):
                disposition = "rejected_invalid_output"
                disposition_reason = "意图模型输出未通过多意图结构校验，已关闭失败为澄清"
            primary = dict(candidates[0])
            next_state = replace(
                state,
                intent=primary,
                intents=candidates,
                scenario=str(primary["scenario"]),
                last_model_call_revision_id=revision_id,
            )
            public_output: Any = {
                "intent_count": len(candidates),
                "combination_policy": "single" if len(candidates) == 1 else "sequential",
                "intents": list(candidates),
            }
        elif self._result_kind == "plan":
            next_state = replace(state, plan=text, last_model_call_revision_id=revision_id)
            public_output = text
        elif self._result_kind == "response":
            next_state = replace(state, response=text, last_model_call_revision_id=revision_id)
            public_output = text
        elif self._result_kind == "summary":
            summary = _json_object(text)
            if summary is None:
                summary = {
                    "topic": state.intent.get("goal") if state.intent else state.origin_prompt[:80],
                    "confirmed_facts": [],
                    "decisions": [],
                    "open_questions": [],
                    "project_hint": state.intent.get("project_hint") if state.intent else None,
                    "work_state_candidates": [],
                    "memory_candidates": [],
                    "extraction_warning": "模型未返回有效JSON，仅保存最小主题候选。",
                }
                disposition = "rejected_invalid_output"
                disposition_reason = "主题摘取输出不是有效JSON，已保存确定性最小候选"
            summary, suppressions = _apply_summary_writeback_policy(
                summary,
                origin_prompt=state.origin_prompt,
            )
            if suppressions:
                disposition = "accepted_with_writeback_filter"
                disposition_reason = "模型摘要已采用，但违反用户只读边界的Work/Memory候选被确定性移除"
            next_state = replace(
                state,
                turn_summary=summary,
                last_model_call_revision_id=revision_id,
            )
            public_output = {
                "topic": summary.get("topic"),
                "confirmed_facts": summary.get("confirmed_facts"),
                "open_questions": summary.get("open_questions"),
                "work_state_candidates": summary.get("work_state_candidates"),
                "memory_candidates": summary.get("memory_candidates"),
                "candidate_suppressions": suppressions,
                "note": "Work/Memory仍是候选，不会自动成为长期事实。",
            }
        else:
            raise RuntimeError(f"未知语义结果类型: {self._result_kind}")
        await self._governance.record_model_output_disposition(
            attempt_id=dispatched.attempt_id,
            disposition=disposition,
            reason=disposition_reason,
        )
        await self._trace_content(
            executor_id=self.id,
            actor=self.profile.name,
            content_type=self._result_kind,
            public_input={"origin_prompt": state.origin_prompt, "scenario": state.scenario},
            public_output=public_output,
        )
        await ctx.send_message(next_state)

    async def _request_review_with_state(self, card, state, ctx) -> None:
        """发起MAF request_info中断：把CollaborationState快照夹带进审批卡。

        跨进程恢复时凭这份快照精确重建运行态，而不是从数据库反猜节点现场。
        """

        execution_context = card.setdefault("execution_context", {})
        if isinstance(execution_context, dict):
            execution_context["workflow_state"] = asdict(state)
        await ctx.request_info(card, dict, request_id=str(card["approval_id"]))


class IntentSetProjectionExecutor(Executor, TraceMixin):
    """学习阶段S2、节点7：先持久化Intent候选，再允许产品决定接受。

    它把模型候选拆成不可变Intent Set/Intent revisions，并处理跨Run澄清关联；这样
    节点8审核的是可定位版本，而不是进程内一段随时会变的字典。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        intents: CollaborationIntentService,
    ) -> None:
        """节点7 intent_set_projection：注入Intent服务并固定executor_id；执行见@handler。"""

        super().__init__(id="intent_set_projection")
        self._run_id = run_id
        self._intents = intents
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def project(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点7：创建Intent Set候选revision，并把澄清状态持久化后交给节点8。"""
        candidates = state.intents or ((state.intent or {}),)
        pending_id = str((state.pending_clarification or {}).get("id") or "")
        answers_pending = bool(
            pending_id
            and any(str(value.get("answers_clarification_id") or "") == pending_id for value in candidates)
        )
        answered = None
        if answers_pending:
            answered = await self._intents.answer_latest_open(
                session_id=self._thread_id,
                answering_run_id=self._run_id(),
                answer_text=state.origin_prompt,
            )
        projected = await self._intents.record_candidate(
            run_id=self._run_id(),
            origin_prompt=state.origin_prompt,
            intents=candidates,
            source_model_call_revision_id=state.last_model_call_revision_id,
            combination_policy="single" if len(candidates) == 1 else "sequential",
        )
        next_state = replace(
            state,
            intent_set_id=projected["id"],
            intent_set_revision_id=projected["current_revision"]["id"],
            intent_set_revision_hash=projected["current_revision"]["revision_hash"],
            answered_clarification=answered,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_intent_projector",
            content_type="intent_set",
            public_input={
                "candidate_count": len(candidates),
                "pending_clarification_id": pending_id or None,
                "answers_pending_clarification": answers_pending,
            },
            public_output={
                "intent_set_id": projected["id"],
                "revision": projected["current_revision"]["revision"],
                "revision_hash": projected["current_revision"]["revision_hash"],
                "combination_policy": projected["current_revision"]["combination_policy"],
                "execution_order": projected["current_revision"]["execution_order"],
                "status": projected["status"],
                "answered_clarification_id": answered["id"] if answered else None,
            },
        )
        await ctx.send_message(next_state)


class IntentSetAcceptanceExecutor(Executor, TraceMixin):
    """学习阶段S2、节点9：接受用户审核后精确Hash绑定的Intent Set。

    如果节点8修改了主Intent，先生成新revision，再只接受该revision；旧批准不能漂移
    到新内容。输出同步回Workflow State，供Project解析和后续路由读取。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        intents: CollaborationIntentService,
    ) -> None:
        """节点9 intent_set_acceptance：注入Intent服务并固定executor_id；执行见@handler。"""

        super().__init__(id="intent_set_acceptance")
        self._run_id = run_id
        self._intents = intents
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def accept(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点9：校验当前Set Hash，接受精确revision并投影回运行状态。"""
        candidates = state.intents or ((state.intent or {}),)
        projected = await self._intents.record_candidate(
            run_id=self._run_id(),
            origin_prompt=state.origin_prompt,
            intents=candidates,
            source_model_call_revision_id=state.last_model_call_revision_id,
            author_kind="workflow_review",
            combination_policy="single" if len(candidates) == 1 else "sequential",
        )
        accepted = False
        if state.scenario != "clarify":
            projected = await self._intents.accept_current(
                intent_set_id=projected["id"],
                expected_revision_hash=projected["current_revision"]["revision_hash"],
            )
            accepted = True
        next_state = replace(
            state,
            intent_set_id=projected["id"],
            intent_set_revision_id=projected["current_revision"]["id"],
            intent_set_revision_hash=projected["current_revision"]["revision_hash"],
        )
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_intent_acceptance",
            content_type="intent_set_acceptance",
            public_input={
                "intent_set_id": projected["id"],
                "scenario": state.scenario,
                "candidate_count": len(candidates),
            },
            public_output={
                "accepted": accepted,
                "status": projected["status"],
                "revision": projected["current_revision"]["revision"],
                "revision_hash": projected["current_revision"]["revision_hash"],
                "note": (
                    "澄清Intent保持candidate，等待下一条用户输入"
                    if not accepted
                    else "当前不可变Intent Set revision已接受"
                ),
            },
        )
        await ctx.send_message(next_state)


class ScenarioRouterExecutor(Executor, TraceMixin):
    """学习阶段S3、节点16：在4条候选边中确定性选择一条。

    不调用模型，只读取已接受Intent状态，在Project目录查询、澄清、规划、默认直接执行
    中按声明顺序首个命中。选中依据及每条未选原因都会写入Trace供双报告还原。
    """

    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        """节点16 scenario_router：注入会话服务并固定executor_id；执行见@handler。"""

        super().__init__(id="scenario_router")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    # BP-16 触发：S3场景路由。根据已接受的Intent/Intent Set和当前状态，
    # 调用_evaluate_scenario_route选择目录查询、澄清、规划或默认路径。
    # 跨边界：Workflow内部路由节点，承接IntentSetAcceptanceExecutor的CollaborationState。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S3-场景路由与可选规划.md
    async def route(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        """S3场景路由节点。根据已接受的Intent/Intent Set和当前状态选择执行分支。

        调用_evaluate_scenario_route评估命中条件，在目录查询、澄清、规划或默认路径中
        选择首个命中分支，并把选中/未选原因完整写入Trace。路由结果写入state.scenario
        后发送给下一节点（ProjectCatalogExecutor或ClarificationExecutor等）。

        跨边界：Workflow内部路由节点，承接IntentSetAcceptanceExecutor的CollaborationState。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S3-场景路由与可选规划.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-16
        # DEBUG-BREAKPOINT-NOTE: 触发: S3场景路由。
        # DEBUG-BREAKPOINT-NOTE: 触发: 根据已接受的Intent/Intent Set和当前状态，调用_evaluate_scenario_route选择目录查询、澄清、规划或默认路径。
        # DEBUG-BREAKPOINT-NOTE: 触发: 不直接调用BP-21的原始文本护栏。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S3-场景路由与可选规划。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每条用户消息触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-16
        route_decision = _evaluate_scenario_route(state)
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_scenario_router",
            content_type="scenario_route",
            public_input=state.intent,
            public_output={
                "scenario": state.scenario,
                "branch": route_decision["selected_branch"],
                "route_decision": route_decision,
            },
        )
        await ctx.send_message(state)


class ProjectCatalogExecutor(Executor, TraceMixin):
    """学习阶段S3、节点17：只用Product事实回答正式Project目录查询。

    该分支为0次模型调用；正式目录为空时明确返回空，并把聊天摘要中的Project提示标为
    候选而不是正式事实。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        """节点17 project_catalog_query：注入Harness服务并固定executor_id；执行见@handler。"""

        super().__init__(id="project_catalog_query")
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    # BP-17 触发：项目目录查询响应。仅当ScenarioRouterExecutor路由到目录查询分支时才命中。
    # 0次模型调用，直接从Product DB查询并渲染正式Project目录。
    # 跨边界：Workflow内部目录分支，承接ScenarioRouterExecutor路由结果，调用HarnessService.list_projects。
    # 对应文档：项目掌握/调试实战/场景/SC01-确定性查询正式Project目录.md
    async def answer(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        """项目目录查询响应节点。仅当ScenarioRouterExecutor路由到目录查询分支时才命中。

        0次模型调用：直接调用HarnessService.list_projects查询正式Project，渲染为目录结果
        和助手回复文本，写入TurnSummary后发送给下游。正式目录为空时明确返回空，并把
        聊天摘要中的Project提示标为候选而非正式事实。

        跨边界：Workflow内部目录分支，承接ScenarioRouterExecutor路由结果，调用HarnessService.list_projects。
        对应文档：项目掌握/调试实战/场景/SC01-确定性查询正式Project目录.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-17
        # DEBUG-BREAKPOINT-NOTE: 触发: 项目目录查询响应。
        # DEBUG-BREAKPOINT-NOTE: 触发: 仅当BP-16路由到目录查询分支时才命中。
        # DEBUG-BREAKPOINT-NOTE: 触发: 生成目录查询的响应与摘要。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：场景SC01-确定性查询正式Project目录。
        # DEBUG-BREAKPOINT-NOTE: 频率: 仅在项目目录查询时触发（条件性）
        breakpoint()  # DEBUG-BREAKPOINT: BP-17
        catalog_result = state.project_catalog_result
        if catalog_result is None:
            projects = await self._harness.list_projects(
                statuses=("proposed", "active", "paused", "completed"),
            )
            catalog_result = _render_project_catalog_result(
                projects,
                list(state.project_candidates),
            )
        projects = list(catalog_result["formal_projects"])
        response = str(catalog_result["assistant_response"])
        summary = {
            "topic": "查看现有项目列表",
            "confirmed_facts": [
                {
                    "text": f"当前正式Project数量为{len(projects)}",
                    "source_refs": [
                        {
                            "kind": "product_query",
                            "id": "project_catalog",
                        }
                    ],
                }
            ],
            "decisions": [],
            "open_questions": [],
            "project_hint": None,
            "work_state_candidates": [],
            "memory_candidates": [],
            "query_kind": "project_catalog",
        }
        next_state = replace(state, response=response, turn_summary=summary)
        await self._trace_content(
            executor_id=self.id,
            actor="product_project_catalog",
            content_type="project_catalog_query",
            public_input={"query": state.origin_prompt},
            public_output={
                **catalog_result,
            },
        )
        await ctx.send_message(next_state)


class ExecutionDraftCompilerExecutor(Executor, TraceMixin):
    """学习阶段S4、节点21：编译可编辑、可审核的ExecutionDraft。

    这里解析Repository围栏并在授权前冻结pi编辑的Validation Contract，避免RunSpec在
    之后重新读取“当前计划”。输出是带revision和Hash的候选Draft；节点22授权前不能执行。
    编译失败会用稳定脱敏错误码关闭Run，不产生半份执行合同。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        repository_execution_context: RepositoryExecutionContextService,
        pi_available: bool,
        validation_planner: ValidationContractPlanner,
    ) -> None:
        """节点21 execution_draft_compiler：注入执行调度服务并固定executor_id；执行见@handler。"""

        super().__init__(id="execution_draft_compiler")
        self._thread_id = thread_id
        self._run_id = run_id
        self._governance = governance
        self._repository_execution_context = repository_execution_context
        self._pi_available = pi_available
        self._validation_planner = validation_planner
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def compile(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        """执行节点21：冻结Repository/Validation输入并保存ExecutionDraft revision。"""
        try:
            repository_fence = None
            source = adopted_repository_source(state.context_items)
            if state.selected_project_id and source is not None:
                repository_fence = await self._repository_execution_context.resolve_fence(
                    project_id=state.selected_project_id,
                    binding_id=source["binding_id"],
                    expected_semantic_hash=source["semantic_hash"],
                )
            # P0-1：pi隔离编辑的Validation Contract在授权前冻结（精确Plan
            # revision、subject Action id/revision与compiled argv/hash/capability），
            # RunSpec批准后不再读取“当前Plan”；无完成主体时显式记录null。
            frozen_contract = VALIDATION_CONTRACT_UNSET
            if repository_fence is not None and recommends_pi_workspace_edit(
                prompt=execution_routing_text(state),
                selected_project_id=state.selected_project_id,
                repository_fence=repository_fence,
                pi_available=self._pi_available,
            ):
                frozen_contract = await self._validation_planner.freeze(
                    context_items=state.context_items,
                    fence=repository_fence,
                )
            payload, brief = compile_execution_draft_v2(
                state=state,
                thread_id=self._thread_id,
                run_id=self._run_id(),
                workflow_id=WORKFLOW_ID,
                workflow_version=WORKFLOW_VERSION,
                repository_fence=repository_fence,
                pi_available=self._pi_available,
                validation_contract=frozen_contract,
            )
            draft, revision = await self._governance.create_execution_draft(
                session_id=self._thread_id,
                run_id=self._run_id(),
                workflow_definition_id=WORKFLOW_ID,
                workflow_version=WORKFLOW_VERSION,
                payload=payload,
                execution_brief=brief,
            )
        except Exception as error:
            # P1-5：已知domain code原样保留；未知异常统一稳定错误码与脱敏
            # 消息，不把路径/SQL/内部异常写进Run失败记录。
            code = getattr(error, "code", None)
            if not isinstance(code, str) or not code:
                code = "EXECUTION_DRAFT_COMPILE_FAILED"
            message = (
                str(error)
                if code != "EXECUTION_DRAFT_COMPILE_FAILED"
                else "执行草稿编译失败，请修正输入后重试；若持续出现请联系管理员。"
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                error_code=code,
                message=message,
            )
            raise
        next_state = replace(state, execution_draft_revision_id=revision.id)
        await self._trace_content(
            executor_id=self.id,
            actor="execution_governance_compiler",
            content_type="execution_draft",
            public_input={
                "intent": state.intent,
                "plan": state.plan,
                "context_package_id": (state.detail_context_package_id or state.directory_context_package_id),
                "repository_fence": repository_fence.public_view() if repository_fence else None,
            },
            public_output={
                "execution_brief": brief,
                "draft_revision_id": revision.id,
                "draft_hash": revision.draft_hash,
                "status": revision.status,
                "empty_reasons": {
                    **(
                        {
                            "public_input.plan": {
                                "code": "not_applicable",
                                "reason": "场景路由没有要求规划，本轮按已接受Intent和协议直接编译Draft。",
                            }
                        }
                        if state.plan is None
                        else {}
                    ),
                    **(
                        {
                            "public_input.repository_fence": {
                                "code": "not_applicable",
                                "reason": "本轮没有采用可执行Repository来源，不建立仓库围栏。",
                            }
                        }
                        if repository_fence is None
                        else {}
                    ),
                },
            },
        )
        await ctx.send_message(next_state)


class RunSpecCompilerExecutor(Executor, TraceMixin):
    """学习阶段S4、节点23：只从已授权Draft编译不可变RunSpec。

    RunSpec冻结本轮Runtime、能力、预算、Repository Snapshot和验证合同，并绑定Product
    Run。节点24只读RunSpec路由，不再重新解释用户原文。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        """节点23 run_spec_compiler：注入执行调度服务并固定executor_id；执行见@handler。"""

        super().__init__(id="run_spec_compiler")
        self._run_id = run_id
        self._governance = governance
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def compile(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        """执行节点23：从已授权Draft构造RunSpec，绑定当前Product Run并进入节点24。"""
        if not state.execution_draft_revision_id:
            raise GovernanceConflict("缺少已授权的ExecutionDraft revision")
        accepted = await self._governance.accepted_execution_draft(state.execution_draft_revision_id)
        spec_payload = compile_run_spec_v2(
            accepted=accepted,
            state=state,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            workflow_id=WORKFLOW_ID,
            workflow_version=WORKFLOW_VERSION,
        )
        spec = await self._governance.compile_run_spec(
            draft_revision_id=state.execution_draft_revision_id,
            scopes=[
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
                {"kind": "product_session", "ref_id": self._thread_id},
                {"kind": "run", "ref_id": self._run_id()},
                {"kind": "workflow_version", "ref_id": WORKFLOW_ID},
                {"kind": "scenario", "ref_id": state.scenario},
            ],
            spec_payload=spec_payload,
            run_id=self._run_id(),
        )
        next_state = replace(state, run_spec_id=spec.id)
        await self._trace_content(
            executor_id=self.id,
            actor="run_spec_compiler",
            content_type="run_spec",
            public_input={
                "accepted_draft_revision_id": accepted["revision_id"],
                "draft_hash": accepted["draft_hash"],
            },
            public_output={
                "run_spec_id": spec.id,
                "run_spec_hash": spec.run_spec_hash,
                "status": spec.status,
            },
        )
        await ctx.send_message(next_state)


class ClarificationExecutor(Executor, TraceMixin):
    """学习阶段S3、节点18：提交澄清问题并回到聊天输入。

    澄清答案是下一条新的User Message，不是accept/revise审批。本节点写Assistant问题，
    把TurnSummary标为``awaiting_user_answer``并正常收口；下一轮节点6/7再关联答案。
    """

    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        """节点18 clarification：注入会话服务并固定executor_id；执行见@handler。"""

        super().__init__(id="clarification")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def clarify(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        """执行节点18：形成澄清问题与最小TurnSummary，下一轮再接收用户答案。"""
        intent = state.intent or {}
        question = str(intent.get("clarification_question") or "你希望我接下来具体推进哪件事？")
        response = f"{question}\n\n请直接在下方输入框回答。"
        next_state = replace(
            state,
            response=response,
            turn_summary={
                "topic": intent.get("goal") or state.origin_prompt[:80],
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [question],
                "project_hint": intent.get("project_hint"),
                "work_state_candidates": [],
                "memory_candidates": [],
                "awaiting_user_answer": True,
                "clarification_context": {
                    "original_user_request": state.origin_prompt,
                    "question": question,
                },
            },
        )
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_clarification",
            content_type="clarification",
            public_input=intent,
            public_output={
                "question": question,
                "answer_surface": "next_chat_input",
                "note": "澄清是新用户输入，不使用接受/修改审批动作。",
            },
        )
        await ctx.send_message(next_state)


class HarnessCandidateCommitExecutor(Executor, TraceMixin):
    """学习阶段S7、节点37：只提交已通过决定点的Work/Memory候选。

    以Decision Record作为授权事实，通过幂等命令和CAS写Harness；未批准、被跳过或为空的
    候选不会写入长期状态。提交结果与原因进入Trace和TurnSummary引用。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        """节点37 harness_candidate_commit：注入Harness服务并固定executor_id；执行见@handler。"""

        super().__init__(id="harness_candidate_commit")
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def commit(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """执行节点37：为空时记录不适用；有候选时按Decision IDs幂等提交。"""
        summary = state.turn_summary or {}
        work_candidates = list(summary.get("work_state_candidates") or [])
        memory_candidates = list(summary.get("memory_candidates") or [])
        if not work_candidates and not memory_candidates:
            await self._trace_content(
                executor_id=self.id,
                actor="product_harness_repository",
                content_type="harness_candidate_commit",
                public_input={"work_count": 0, "memory_count": 0},
                public_output={
                    "status": "not_applicable",
                    "reason": "本轮TurnSummary没有提出Work或Memory候选，无长期事实需要提交。",
                },
            )
            await ctx.send_message(state)
            return
        result = await self._harness.commit_turn_candidates(
            command_id=f"turn-candidates:{self._run_id()}",
            session_id=self._thread_id,
            run_id=self._run_id(),
            project_id=state.selected_project_id,
            work_candidates=work_candidates,
            memory_candidates=memory_candidates,
            decision_record_ids=state.harness_decision_record_ids,
        )
        next_state = replace(state, harness_commit_results=result)
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_repository",
            content_type="harness_candidate_commit",
            public_input={
                "work_candidates": work_candidates,
                "memory_candidates": memory_candidates,
                "decision_record_ids": list(state.harness_decision_record_ids),
            },
            public_output=result,
        )
        await ctx.send_message(next_state)


class TurnSummaryPersistExecutor(Executor, TraceMixin):
    """学习阶段S7、节点38：在候选决定结束后保存本轮派生摘要。

    TurnSummary用于后续有界召回，不能替代原始Message，也不是Accepted Memory。保存时
    关联模型Attempt、来源Context、已提交Product事实和未解决澄清。
    """

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        """节点38 turn_summary_persist：注入会话服务并固定executor_id；执行见@handler。"""

        super().__init__(id="turn_summary_persist")
        self._run_id = run_id
        self._governance = governance
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    # BP-18 触发：S6回合摘要持久化。每个对话回合结束时执行，在FinalizeExecutor之前。
    # 将TurnSummary写入Product DB，绑定source_model_call_revision_id和product_fact_refs。
    # 跨边界：Workflow内部持久化节点，调用ProductSessionService.save_turn_summary写入Product DB。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S6-响应摘要与提交决定.md
    async def persist(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        """S6回合摘要持久化节点。每个对话回合结束时执行，在FinalizeExecutor之前。

        将TurnSummary（若无则用确定性最小主题候选）写入Product DB，绑定source_model_call_revision_id
        和本轮已提交的product_fact_refs，使摘要可追溯到模型调用和产品事实来源。持久化后
        把状态发送给FinalizeExecutor做最终收尾。

        跨边界：Workflow内部持久化节点，调用ProductSessionService.save_turn_summary写入Product DB。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S6-响应摘要与提交决定.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-18
        # DEBUG-BREAKPOINT-NOTE: 触发: S6回合摘要持久化。
        # DEBUG-BREAKPOINT-NOTE: 触发: 每个对话回合结束时，将TurnSummary写入Product DB。
        # DEBUG-BREAKPOINT-NOTE: 触发: 在BP-19 FinalizeExecutor之前执行。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S6-响应摘要与提交决定。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个对话回合结束触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-18
        summary = dict(
            state.turn_summary
            or {
                "topic": (state.intent or {}).get("goal") or state.origin_prompt[:80],
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": (state.intent or {}).get("project_hint"),
                "work_state_candidates": [],
                "memory_candidates": [],
                "extraction_warning": "本轮未形成模型摘要，保存确定性的最小主题候选。",
            }
        )
        persisted = await self._governance.save_turn_summary(
            session_id=self._thread_id,
            run_id=self._run_id(),
            summary=summary,
            source_model_call_revision_id=state.last_model_call_revision_id,
            product_fact_refs=_committed_product_fact_refs(state.harness_commit_results),
        )
        persisted_digest = dict(persisted["summary"])
        next_state = replace(state, turn_summary=persisted_digest)
        await self._trace_content(
            executor_id=self.id,
            actor="turn_summary_repository",
            content_type="turn_summary_commit",
            public_input={
                "topic": persisted_digest.get("topic"),
                "work_state_candidates": persisted_digest.get("work_state_candidates") or [],
                "memory_candidates": persisted_digest.get("memory_candidates") or [],
            },
            public_output={
                "turn_summary_id": persisted["id"],
                "summary_hash": persisted["summary_hash"],
                "status": persisted["status"],
                "note": "摘要是可追溯的回合派生候选；不替代原始Message，也不自动成为Work或Accepted Memory。",
                "empty_reasons": {
                    **(
                        {
                            "public_input.work_state_candidates": {
                                "code": "not_applicable",
                                "reason": "本轮没有Work状态候选，节点35及37不会写Work事实。",
                            }
                        }
                        if not persisted_digest.get("work_state_candidates")
                        else {}
                    ),
                    **(
                        {
                            "public_input.memory_candidates": {
                                "code": "not_applicable",
                                "reason": "本轮没有长期Memory候选，节点36及37不会写Accepted Memory。",
                            }
                        }
                        if not persisted_digest.get("memory_candidates")
                        else {}
                    ),
                },
            },
        )
        await ctx.send_message(next_state)


def _committed_product_fact_refs(
    result: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """把已提交Harness结果投影为TurnSummary可追溯引用，不复制事实正文。"""

    if not result:
        return []
    refs: list[dict[str, Any]] = []
    for kind, key in (
        ("work_item", "work_items"),
        ("accepted_memory", "accepted_memory"),
    ):
        for value in result.get(key) or []:
            if not isinstance(value, Mapping) or not value.get("id"):
                continue
            refs.append(
                {
                    "kind": kind,
                    "id": str(value["id"]),
                    **({"revision": value["row_version"]} if value.get("row_version") is not None else {}),
                }
            )
    return refs


class FinalizeExecutor(Executor, TraceMixin):
    """学习阶段S7、节点39：把答复交给图外Product Message最终提交门。

    这里把response产出为AG-UI文本；``ProductAwareWorkflow``随后才把它提交为权威
    Assistant Message并关闭Run。此前若失败/放弃，本节点不会被走到，因此半状态不能
    冒充成功。终态事务随后物化机器版和人读版双Trace。
    """

    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        """节点39 result_finalization：注入会话服务并固定executor_id；执行见@handler。"""

        super().__init__(id="result_finalization")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler
    # BP-19 触发：S7 Workflow最终化。所有业务节点执行完毕后做收尾处理
    # （清理、状态收敛、准备提交）。之后Workflow返回，控制权回到complete_active_run完成门。
    # 跨边界：Workflow末尾节点，把最终候选文本经ctx返回给ProductAwareWorkflow调用方。
    # 对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S7-产品事实写入与本轮终态.md
    async def finalize(self, state: CollaborationState, ctx: WorkflowContext[None, str]) -> None:
        """S7 Workflow最终化节点。所有业务节点执行完毕后做收尾处理。

        公开最终候选回复文本（response或默认提示），把本轮execution_draft_revision_id、
        run_spec_id和turn_summary作为公开输入写入Trace，并把文本经ctx返回给
        ProductAwareWorkflow。之后Workflow返回，控制权回到complete_active_run完成门，
        由完成门负责把结果提交给Product Session和AG-UI。

        跨边界：Workflow末尾节点，把最终候选文本经ctx返回给ProductAwareWorkflow调用方。
        对应文档：项目掌握/Workflow架构与ProductAwareWorkflow/学习阶段S7-产品事实写入与本轮终态.md
        """
        # DEBUG-BREAKPOINT-NOTE: BP-19
        # DEBUG-BREAKPOINT-NOTE: 触发: S7 Workflow最终化。
        # DEBUG-BREAKPOINT-NOTE: 触发: 所有业务节点执行完毕后，做收尾处理（清理、状态收敛、准备提交）。
        # DEBUG-BREAKPOINT-NOTE: 触发: 之后Workflow返回，控制权回到BP-06完成门。
        # DEBUG-BREAKPOINT-NOTE: 触发: 对应文档：学习阶段S7-产品事实写入与本轮终态。
        # DEBUG-BREAKPOINT-NOTE: 频率: 每个Run结束触发1次
        breakpoint()  # DEBUG-BREAKPOINT: BP-19
        response = state.response or "本轮没有形成可提交的答复。"
        await self._trace_content(
            executor_id=self.id,
            actor="product_finalization_gate",
            content_type="result_candidate",
            public_input={
                "execution_draft_revision_id": state.execution_draft_revision_id,
                "run_spec_id": state.run_spec_id,
                "turn_summary": state.turn_summary,
            },
            public_output={
                "assistant_response": response,
                "commit": "Product Message",
                "empty_reasons": {
                    **(
                        {
                            "public_input.execution_draft_revision_id": {
                                "code": "not_applicable",
                                "reason": "本轮走Project目录或澄清分支，没有编译ExecutionDraft。",
                            }
                        }
                        if state.execution_draft_revision_id is None
                        else {}
                    ),
                    **(
                        {
                            "public_input.run_spec_id": {
                                "code": "not_applicable",
                                "reason": "本轮没有进入执行合同分支，因此没有RunSpec。",
                            }
                        }
                        if state.run_spec_id is None
                        else {}
                    ),
                },
            },
        )
        await ctx.yield_output(response)


def _revise_context(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    """处理context_adoption决定卡（S1节点4）的用户修改，只改运行态投影。

    ``skip``清空本轮摘要采用；否则必须提供``selected_summary_ids``。权威持久化由后续
    revision节点写新ContextPackage完成，这里不产生新事实。
    """

    if changes.get("skip"):
        return replace(state, recent_turn_summaries=())
    selected = changes.get("selected_summary_ids")
    if not isinstance(selected, list) or not all(isinstance(value, str) for value in selected):
        raise ValueError("Context修改必须提供selected_summary_ids")
    selected_ids = set(selected)
    return replace(
        state,
        recent_turn_summaries=tuple(
            value for value in state.recent_turn_summaries if str(value.get("id")) in selected_ids
        ),
    )


def _revise_intent(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    """处理intent_binding决定卡（S2节点8）的用户修改。

    整体替换``intents``时重新过``normalize_intent_candidates``同一纯边界（1-4个），
    失败关闭的澄清结果直接报错拒绝；单字段修改时重算scenario合法性、confidence与
    needs_clarification。修改只作用于运行态，新Intent revision由投影节点落库。
    """

    if "intents" in changes:
        raw_intents = changes["intents"]
        if not isinstance(raw_intents, list) or not 1 <= len(raw_intents) <= 4:
            raise ValueError("Intent Set必须包含1到4个Intent")
        if not all(isinstance(value, Mapping) for value in raw_intents):
            raise ValueError("Intent Set中的每个Intent都必须是结构化对象")
        revised_intents = _normalize_intent_candidates(
            {"intents": raw_intents},
            origin_prompt=state.origin_prompt,
        )
        if (
            len(revised_intents) == 1
            and revised_intents[0]["scenario"] == "clarify"
            and revised_intents[0]["confidence"] == 0
        ):
            raise ValueError(str(revised_intents[0]["reason_summary"]))
        primary = dict(revised_intents[0])
        return replace(
            state,
            intent=primary,
            intents=revised_intents,
            scenario=str(primary["scenario"]),
        )
    current = dict(state.intent or {})
    for key in ("scenario", "goal", "project_hint", "needs_plan", "clarification_question"):
        if key in changes:
            current[key] = changes[key]
    scenario = str(current.get("scenario") or "clarify")
    if scenario not in {
        "simple_question",
        "continue_project",
        "new_task",
        "plan_request",
        "learning",
        "clarify",
    }:
        raise ValueError("意图场景无效")
    current["confidence"] = 1.0
    current["needs_clarification"] = scenario == "clarify"
    remaining = state.intents[1:] if state.intents else ()
    return replace(
        state,
        intent=current,
        intents=(current, *remaining),
        scenario=scenario,
    )


def _revise_project(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    """处理project_work_binding决定卡（S2节点11）的修改：更新意图绑定与selected_project_id。"""
    current = dict(state.intent or {})
    project_id = changes.get("project_id")
    if project_id in {None, ""}:
        current["project_hint"] = None
        return replace(state, intent=current, selected_project_id=None)
    if not isinstance(project_id, str):
        raise ValueError("Project修改必须选择正式Project ID或不关联")
    match = next((value for value in state.project_matches if value.get("id") == project_id), None)
    if match is None:
        raise ValueError("选择的Project不在本轮权威候选目录中")
    current["project_hint"] = match.get("title")
    return replace(state, intent=current, selected_project_id=project_id)


def _revise_plan(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    """处理plan_acceptance决定卡（S3节点20）的修改：用用户改写后的文本替换运行态Plan候选。"""
    if changes.get("skip"):
        return replace(state, plan=None)
    value = changes.get("plan_text")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Plan修改后不能为空")
    return replace(state, plan=value.strip())


def _revise_result(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    """处理result_commit决定卡（S6节点34）的修改：用用户改写后的文本替换本轮response候选。"""
    value = changes.get("response_text")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Result修改后不能为空")
    return replace(state, response=value.strip())


def _revise_execution_draft(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    """处理execution_authorization决定卡（S4节点22）的修改：把授权目标切到新Draft revision。

    revision变化意味着旧授权立即失效；这里只更新运行态引用，版本化与Hash由治理服务拥有。
    """
    revision_id = changes.get("execution_draft_revision_id")
    if not isinstance(revision_id, str) or not revision_id:
        raise ValueError("ExecutionDraft修改必须绑定新的revision")
    return replace(state, execution_draft_revision_id=revision_id)


def _revise_summary_candidates(
    state: CollaborationState,
    changes: Mapping[str, Any],
    key: str,
) -> CollaborationState:
    """处理摘要候选决定卡（S6）的修改：按字段名合并用户编辑后的候选列表到运行态摘要。"""
    summary = dict(state.turn_summary or {})
    if changes.get("skip"):
        summary[key] = []
    else:
        value = changes.get(key)
        if not isinstance(value, list):
            raise ValueError(f"{key}修改必须是候选列表")
        summary[key] = value
    return replace(state, turn_summary=summary)


def _decision_specs() -> dict[str, ProductDecisionSpec]:
    """登记主Workflow全部HITL决定点规格：Subject内容、适用性、事实、可编辑字段与修改处理器。

    ``ProductDecisionExecutor``是通用执行器，节点差异全部来自这张表；调试某个决定卡时
    先在这里定位它的key，再看对应``_revise_*``如何处理用户修改。
    """

    return {
        "context_adoption": ProductDecisionSpec(
            key="context_adoption",
            subject_kind="context_package",
            title="确认本轮采用的上下文",
            description="这些主题摘要将进入后续意图识别；完整历史仍只作为证据保留。",
            accept_action="accept",
            applicable=lambda state: bool(state.recent_turn_summaries or state.project_matches),
            subject=lambda state: {
                "selected_summaries": list(state.recent_turn_summaries),
                "project_directory_matches": list(state.project_matches),
                "context_package_id": state.directory_context_package_id,
            },
            facts=lambda state: {
                "context": {
                    "requires_review": False,
                    "cross_project": len(
                        {
                            str(value.get("project_hint"))
                            for value in state.recent_turn_summaries
                            if value.get("project_hint")
                        }
                    )
                    > 1,
                    "source_invalid": False,
                }
            },
            editable_fields=lambda state: (
                [
                    {
                        "key": "selected_summary_ids",
                        "label": "采用的主题摘要",
                        "type": "multi_select",
                        "value": [str(value.get("id")) for value in state.recent_turn_summaries],
                        "options": [
                            {"value": str(value.get("id")), "label": str(value.get("topic") or "未命名主题")}
                            for value in state.recent_turn_summaries
                        ],
                    }
                ]
                if state.recent_turn_summaries
                else []
            ),
            revise=_revise_context,
            allow_skip=True,
        ),
        "detail_context_adoption": ProductDecisionSpec(
            key="context_adoption",
            subject_kind="context_package",
            title="确认本轮采用的项目与仓库信息",
            description=(
                "确认将进入后续计划和响应的Project、Repository Snapshot与治理规则；"
                "需要调整时可先在本轮协作信息中采用、排除或载入正文。"
            ),
            accept_action="accept",
            applicable=lambda state: state.detail_context_package_id is not None,
            subject=lambda state: {
                "context_package_id": state.detail_context_package_id,
                "sources": [
                    {
                        "source_kind": value.get("source_kind"),
                        "source_id": value.get("source_id"),
                        "source_revision": value.get("source_revision"),
                        "title": value.get("title"),
                        "adopted": value.get("adopted"),
                        "reason": value.get("reason"),
                        "token_estimate": value.get("token_estimate"),
                    }
                    for value in state.context_items
                ],
            },
            facts=lambda state: {
                "context": {
                    "requires_review": False,
                    "cross_project": False,
                    "source_invalid": False,
                    "repository_source_count": sum(
                        str(value.get("source_kind") or "").startswith("repository_")
                        for value in state.context_items
                    ),
                }
            },
            editable_fields=lambda state: [],
            revise=lambda state, changes: state,
            allow_skip=False,
        ),
        "intent_binding": ProductDecisionSpec(
            key="intent_binding",
            subject_kind="intent",
            title="确认我对本轮意图的理解",
            description="确认目标和场景，避免把简单询问误建成任务或关联到错误Project。",
            accept_action="accept",
            applicable=lambda state: state.intent is not None and state.scenario != "clarify",
            subject=lambda state: {
                "intent_set_id": state.intent_set_id,
                "combination_policy": "single" if len(state.intents) <= 1 else "sequential",
                "intents": list(state.intents or ((state.intent or {}),)),
            },
            facts=lambda state: {
                "intent": {
                    "confidence": float((state.intent or {}).get("confidence") or 0),
                    "changes_active_work": False,
                    "ambiguous": state.scenario == "clarify",
                }
            },
            editable_fields=lambda state: [
                {
                    "key": "intents",
                    "label": "本轮Intent Set",
                    "type": "intent_set",
                    "value": list(state.intents or ((state.intent or {}),)),
                }
            ],
            revise=_revise_intent,
        ),
        "project_work_binding": ProductDecisionSpec(
            key="project_work_binding",
            subject_kind="work_binding",
            title="确认本轮关联的 Project / Work",
            description="只有明确关联后，Project状态才会进入后续上下文候选。",
            accept_action="accept",
            applicable=lambda state: (
                bool((state.intent or {}).get("project_hint")) or state.scenario == "continue_project"
            ),
            subject=lambda state: {
                "project_hint": (state.intent or {}).get("project_hint"),
                "selected_project_id": state.selected_project_id,
                "formal_project_candidates": list(state.project_matches),
                "scenario": state.scenario,
            },
            facts=lambda state: {
                "project": {
                    "candidate_count": len(state.project_matches),
                    "cross_sensitive_scope": False,
                }
            },
            editable_fields=lambda state: [
                {
                    "key": "project_id",
                    "label": "Project / Work",
                    "type": "select",
                    "value": state.selected_project_id or "",
                    "options": [
                        {"value": "", "label": "本轮不关联正式Project"},
                        *[
                            {"value": str(value["id"]), "label": f"{value['title']} · {value['status']}"}
                            for value in state.project_matches
                        ],
                    ],
                }
            ],
            revise=_revise_project,
            allow_skip=True,
        ),
        "plan_acceptance": ProductDecisionSpec(
            key="plan_acceptance",
            subject_kind="task_plan",
            title="确认本轮计划",
            description="确认步骤、边界和验证方式；也可以本轮暂不规划。",
            accept_action="accept",
            applicable=lambda state: bool(state.plan),
            subject=lambda state: {"plan": state.plan, "scenario": state.scenario},
            facts=lambda state: {
                "plan": {"risk_level": 0, "expands_capability": False, "boundary_unclear": False}
            },
            editable_fields=lambda state: [
                {"key": "plan_text", "label": "计划", "type": "long_text", "value": state.plan or ""}
            ],
            revise=_revise_plan,
            allow_skip=True,
        ),
        "execution_authorization": ProductDecisionSpec(
            key="execution_authorization",
            subject_kind="execution_draft",
            title="授权本轮执行合同",
            description="确认目标、范围、能力和完成门后，才进入协作响应阶段。",
            accept_action="execute",
            applicable=lambda state: bool(state.execution_draft_revision_id),
            subject=lambda state: {
                "execution_draft_revision_id": state.execution_draft_revision_id,
                "scenario": state.scenario,
            },
            facts=lambda state: {
                "execution": {"risk_level": 0, "has_side_effects": False, "goal_incomplete": False}
            },
            editable_fields=lambda state: [
                {
                    "key": "execution_draft_revision_id",
                    "label": "ExecutionDraft完整工作台",
                    "type": "execution_draft",
                    "value": state.execution_draft_revision_id,
                }
            ],
            revise=_revise_execution_draft,
            grant_kind="start_run",
        ),
        "result_commit": ProductDecisionSpec(
            key="result_commit",
            subject_kind="result_candidate",
            title="确认本轮结果",
            description="确认答复和完成声明有当前证据支持，再提交到Product Session。",
            accept_action="accept",
            applicable=lambda state: bool(state.response),
            subject=lambda state: {"response": state.response, "turn_summary": state.turn_summary},
            facts=lambda state: {
                "result": {
                    "evidence_sufficient": True,
                    "external_delivery": False,
                    "changes_long_term_state": False,
                }
            },
            editable_fields=lambda state: [
                {
                    "key": "response_text",
                    "label": "提交给会话的答复",
                    "type": "long_text",
                    "value": state.response or "",
                }
            ],
            revise=_revise_result,
            grant_kind="commit_result",
        ),
        "work_state_commit": ProductDecisionSpec(
            key="work_state_commit",
            subject_kind="work_state_candidate",
            title="确认Work状态候选",
            description="候选不会自动成为任务或Project的长期状态。",
            accept_action="commit",
            applicable=lambda state: bool((state.turn_summary or {}).get("work_state_candidates")),
            subject=lambda state: {
                "candidates": (state.turn_summary or {}).get("work_state_candidates") or []
            },
            facts=lambda state: {
                "work": {"creates_or_deletes": False, "claims_completion_without_evidence": False}
            },
            editable_fields=lambda state: [],
            revise=lambda state, changes: _revise_summary_candidates(state, changes, "work_state_candidates"),
            allow_skip=True,
            grant_kind="commit_work_state",
        ),
        "memory_commit": ProductDecisionSpec(
            key="memory_commit",
            subject_kind="memory_candidate",
            title="确认长期Memory候选",
            description="只有你明确接受的候选才可进入长期Memory；原始会话不受影响。",
            accept_action="commit",
            applicable=lambda state: bool((state.turn_summary or {}).get("memory_candidates")),
            subject=lambda state: {"candidates": (state.turn_summary or {}).get("memory_candidates") or []},
            facts=lambda state: {
                "memory": {"candidate_count": len((state.turn_summary or {}).get("memory_candidates") or [])}
            },
            editable_fields=lambda state: [],
            revise=lambda state, changes: _revise_summary_candidates(state, changes, "memory_candidates"),
            allow_skip=True,
            grant_kind="commit_memory",
        ),
    }


def create_continuous_collaboration_workflow(
    *,
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
    """装配39节点主Workflow的兼容入口：把图连接委托给``continuous_chat_factory``。

    这里只按依赖注入组装行为组件（Executor、决定点规格与协作对象）；节点ID、边顺序和
    图签名由factory唯一拥有，使组件构造与Checkpoint图签名解耦。
    """

    return build_continuous_collaboration_workflow(
        components=ContinuousWorkflowComponents(
            workflow_id=WORKFLOW_ID,
            intake=IntakeExecutor,
            candidates=CandidateContextExecutor,
            directory_context=HarnessDirectoryContextExecutor,
            decision=ProductDecisionExecutor,
            semantic_agent=GovernedSemanticAgentExecutor,
            intent_projection=IntentSetProjectionExecutor,
            intent_acceptance=IntentSetAcceptanceExecutor,
            project_resolver=HarnessProjectResolverExecutor,
            protocol_resolver=CollaborationProtocolResolverExecutor,
            router=ScenarioRouterExecutor,
            detail_context=HarnessDetailContextExecutor,
            context_revision=HarnessContextRevisionExecutor,
            project_catalog=ProjectCatalogExecutor,
            execution_draft_compiler=ExecutionDraftCompilerExecutor,
            run_spec_compiler=RunSpecCompilerExecutor,
            execution_route=ExecutionRouteExecutor,
            execution_workspace_prepare=ExecutionWorkspacePrepareExecutor,
            pi_readonly_dispatch=PiReadonlyDispatchExecutor,
            pi_readonly_result_assembly=PiReadonlyResultAssemblyExecutor,
            pi_workspace_dispatch=PiWorkspaceDispatchExecutor,
            pi_workspace_result_assembly=PiWorkspaceResultAssemblyExecutor,
            result_claim_prepare=ResultClaimPrepareExecutor,
            result_claim_decision=ResultClaimDecisionExecutor,
            clarification=ClarificationExecutor,
            harness_commit=HarnessCandidateCommitExecutor,
            summary_persist=TurnSummaryPersistExecutor,
            finalizer=FinalizeExecutor,
            decision_specs=_decision_specs,
            is_project_catalog_state=_is_project_catalog_state,
            needs_plan=_needs_plan,
        ),
        thread_id=thread_id,
        run_id=run_id,
        profiles=profiles,
        store=store,
        transport=transport,
        sessions=sessions,
        governance=governance,
        harness=harness,
        collaboration_protocols=collaboration_protocols,
        collaboration_intents=collaboration_intents,
        collaboration_contexts=collaboration_contexts,
        repository_freshness=repository_freshness,
        repository_execution_context=repository_execution_context,
        pi_available=pi_available,
        execution_dispatch=execution_dispatch,
        result_pipeline=result_pipeline,
        validation_planner=validation_planner,
        checkpoint_storage=checkpoint_storage,
    )

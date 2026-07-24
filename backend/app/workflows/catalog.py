"""Stable product metadata for code-defined MAF Workflows.

The catalog describes what users can inspect. Runtime progress remains derived
from MAF Workflow events and is never inferred from this graph definition.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True, slots=True)
class WorkflowNodeDefinition:
    id: str
    label: str
    description: str
    kind: str
    runtime_type: str
    parent_id: str | None = None
    depth: int = 0


@dataclass(frozen=True, slots=True)
class WorkflowEdgeDefinition:
    source: str
    target: str
    condition: str | None = None
    branch_id: str | None = None
    label: str | None = None


@dataclass(frozen=True, slots=True)
class WorkflowDefinition:
    id: str
    name: str
    version: str
    description: str
    endpoint: str
    nodes: tuple[WorkflowNodeDefinition, ...]
    edges: tuple[WorkflowEdgeDefinition, ...]
    selectable: bool = False

    def view(self) -> dict[str, object]:
        return asdict(self)


CHAT_MODEL_CALL_APPROVAL_WORKFLOW = WorkflowDefinition(
    id="chat-model-call-approval",
    name="发送前可编辑 Prompt",
    version="1.0.0",
    description="准备真实模型请求，等待用户逐次审批，再发送给 Provider 并提交结果。",
    endpoint="/api/agent",
    nodes=(
        WorkflowNodeDefinition(
            id="model_call_approval",
            label="审批并发送模型请求",
            description="编译可编辑请求、等待审批、准确发送并提交模型结果。",
            kind="approval",
            runtime_type="executor",
        ),
    ),
    edges=(),
    selectable=False,
)


CONTINUOUS_COLLABORATION_WORKFLOW = WorkflowDefinition(
    id="continuous-collaboration",
    name="持续协作主 Workflow",
    version="1.7.0",
    description=(
        "以选择性上下文和意图识别为入口，按场景进入澄清、计划或直接响应，"
        "所有模型调用受HITL治理，并在回合结束提取重点候选。"
    ),
    endpoint="/api/workflows/continuous-collaboration/run",
    nodes=(
        WorkflowNodeDefinition(
            id="input_acceptance",
            label="接纳本轮输入",
            description="保存并读取本轮用户输入，不把审批协议消息混入业务上下文。",
            kind="input",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="context_candidates",
            label="选择候选上下文",
            description="从历史主题摘要中确定性检索最可能相关的候选，不默认叠加完整历史。",
            kind="context",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="harness_directory_context",
            label="读取Product Harness目录",
            description="阶段A读取正式Project轻量目录并保存候选ContextPackage，不从聊天摘要猜Project事实。",
            kind="context",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="context_adoption",
            label="采用Context",
            description="按有效HITL策略自动记录或暂停确认本轮采用的主题摘要。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="directory_context_revision",
            label="投影目录Context revision",
            description="读取当前Run最新目录Context revision，使用户排除或修改后的内容真正进入意图识别。",
            kind="context",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="intent_agent",
            label="意图与场景 Agent",
            description="用最小候选上下文识别一个或多个目标、顺序依赖、Project提示和澄清需要。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="intent_set_projection",
            label="保存Intent Set候选",
            description="把模型候选保存为不可变Intent revisions，并恢复或回答跨Run澄清。",
            kind="governance",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="intent_binding",
            label="绑定本轮意图",
            description="高置信且不改变活动工作的意图可自动通过；歧义时暂停。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="intent_set_acceptance",
            label="接受Intent Set revision",
            description="把用户审核后的意图同步到新revision，并只接受当前Hash绑定的完整Intent Set。",
            kind="governance",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="harness_project_resolver",
            label="解析正式Project",
            description="只把意图中的Project提示解析到权威目录已有ID；零匹配或多匹配不擅自绑定。",
            kind="context",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="project_work_binding",
            label="关联Project / Work",
            description="简单问答不适用；多候选或跨敏感Scope时暂停确认。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="harness_detail_context",
            label="装配Project工作集",
            description=(
                "阶段B按已绑定Project加载开放Work、当前Plan、Action、Note、Accepted Memory、"
                "Repository Snapshot与匹配治理规则，并记录采用与排除。"
            ),
            kind="context",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="detail_context_adoption",
            label="采用项目与仓库Context",
            description="按HITL策略确认本轮真正采用的Project工作集、代码基线与治理规则。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="detail_context_revision",
            label="投影详情Context revision",
            description="读取用户审核后的最新详情Context revision，公开采用原因和Source revision。",
            kind="context",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="collaboration_protocol_resolver",
            label="选择Chat Harness协作协议",
            description=(
                "按Work、Project、用户、系统的优先级绑定不可变协议revision，"
                "公开本轮方法、阶段、规则和选择依据。"
            ),
            kind="governance",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="scenario_router",
            label="场景路由",
            description="按已识别场景进入产品查询、澄清、规划或直接响应分支。",
            kind="decision",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="project_catalog_query",
            label="查询正式Project目录",
            description="从产品事实回答项目列表查询；正式目录为空时只展示明确为空和对话候选，不让模型编造。",
            kind="output",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="clarification",
            label="请求澄清",
            description="无法可靠绑定目标或Project时提交澄清问题，让用户在下一条聊天输入中回答。",
            kind="output",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="planning_agent",
            label="任务规划 Agent",
            description="对新任务、继续Project和明确规划请求形成步骤与验证门。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="plan_acceptance",
            label="接受Plan",
            description="按作用域策略接受、修改或本轮跳过计划。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="execution_draft_compiler",
            label="编译 ExecutionDraft",
            description="把目标、最小上下文、计划、能力和完成门编译成可审核的版本化执行草稿。",
            kind="governance",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="execution_authorization",
            label="授权ExecutionDraft",
            description="Decision Record和一次性Grant绑定当前Draft Hash后才进入响应阶段。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="run_spec_compiler",
            label="编译不可变 RunSpec",
            description="只从已授权的ExecutionDraft revision编译本次运行合同，并绑定Product Run。",
            kind="governance",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="execution_route",
            label="选择执行分支",
            description="只读取已批准RunSpec，确定进入Chat回答、pi只读或隔离编辑；不再重新解释用户文本。",
            kind="decision",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="execution_workspace_prepare",
            label="准备隔离Execution Workspace",
            description=(
                "从已批准的干净Repository Snapshot创建受管Git worktree，"
                "校验base revision并公开安全Workspace投影。"
            ),
            kind="workspace",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="pi_workspace_dispatch",
            label="运行受治理pi隔离编辑",
            description=(
                "在受管worktree中启动pi；逐次审批模型请求和Tool，仅允许有界读取与绑定Hash的单文件精确edit。"
            ),
            kind="agent",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="pi_workspace_result_assembly",
            label="装配pi隔离编辑结果",
            description=(
                "保留工作区、校验ToolExecution和Result Hash，公开变化文件但不提交、不推送、不声明Work完成。"
            ),
            kind="transform",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="pi_readonly_dispatch",
            label="运行受治理pi只读检查",
            description=(
                "在同一Product Run中启动pi子进程；逐次审批模型请求，"
                "只允许Chat自有read、grep、find、ls，并实时公开内部活动。"
            ),
            kind="agent",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="pi_readonly_result_assembly",
            label="装配pi只读结果",
            description="校验ToolExecution终态与Result Hash后确定性装配答复，不追加一次汇总模型调用。",
            kind="transform",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="response_agent",
            label="协作响应 Agent",
            description="只使用本轮明确装配的背景、目标和计划形成可提交答复。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="turn_summary_agent",
            label="提取本轮重点",
            description="提取主题、确认事实、开放问题及Work/Memory候选，不直接写长期事实。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="result_commit",
            label="提交Result",
            description="确认答复与完成声明有当前证据支持，并签发提交授权。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="work_state_commit",
            label="处理Work状态候选",
            description="无候选时明确不适用；存在候选时按策略记录决定。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="memory_commit",
            label="处理Memory候选",
            description="默认由用户确认长期Memory候选；原始会话始终保留。",
            kind="approval",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="harness_candidate_commit",
            label="提交已批准Work / Memory候选",
            description="只把已通过对应Decision Point的候选以幂等产品事务写入Harness事实、Trace与Outbox。",
            kind="governance",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="turn_summary_persist",
            label="保存本轮主题摘要",
            description="在候选处理后保存可追溯的回合派生摘要；不替代原始Message或自动写入长期Memory。",
            kind="output",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="result_finalization",
            label="提交本轮结果",
            description="经过Product Finalization Gate后写入Product Message和Run终态。",
            kind="output",
            runtime_type="executor",
        ),
    ),
    edges=(
        WorkflowEdgeDefinition("input_acceptance", "context_candidates"),
        WorkflowEdgeDefinition("context_candidates", "harness_directory_context"),
        WorkflowEdgeDefinition("harness_directory_context", "context_adoption"),
        WorkflowEdgeDefinition("context_adoption", "directory_context_revision"),
        WorkflowEdgeDefinition("directory_context_revision", "intent_agent"),
        WorkflowEdgeDefinition("intent_agent", "intent_set_projection"),
        WorkflowEdgeDefinition("intent_set_projection", "intent_binding"),
        WorkflowEdgeDefinition("intent_binding", "intent_set_acceptance"),
        WorkflowEdgeDefinition("intent_set_acceptance", "harness_project_resolver"),
        WorkflowEdgeDefinition("harness_project_resolver", "project_work_binding"),
        WorkflowEdgeDefinition("project_work_binding", "harness_detail_context"),
        WorkflowEdgeDefinition(
            "harness_detail_context",
            "detail_context_adoption",
        ),
        WorkflowEdgeDefinition(
            "detail_context_adoption",
            "detail_context_revision",
        ),
        WorkflowEdgeDefinition(
            "detail_context_revision",
            "collaboration_protocol_resolver",
        ),
        WorkflowEdgeDefinition(
            "collaboration_protocol_resolver",
            "scenario_router",
        ),
        WorkflowEdgeDefinition(
            "scenario_router",
            "project_catalog_query",
            "intent.query_kind = project_catalog",
            "project_catalog",
            "查询正式Project目录",
        ),
        WorkflowEdgeDefinition(
            "scenario_router",
            "clarification",
            "state.scenario = clarify",
            "clarification",
            "请求用户澄清",
        ),
        WorkflowEdgeDefinition(
            "scenario_router",
            "planning_agent",
            "needs_plan(state) = true",
            "planning",
            "先形成任务计划",
        ),
        WorkflowEdgeDefinition(
            "scenario_router",
            "execution_draft_compiler",
            "Default（前三条Case均未命中）",
            "direct_response",
            "直接进入执行草稿",
        ),
        WorkflowEdgeDefinition("planning_agent", "plan_acceptance"),
        WorkflowEdgeDefinition("plan_acceptance", "execution_draft_compiler"),
        WorkflowEdgeDefinition("execution_draft_compiler", "execution_authorization"),
        WorkflowEdgeDefinition("execution_authorization", "run_spec_compiler"),
        WorkflowEdgeDefinition("run_spec_compiler", "execution_route"),
        WorkflowEdgeDefinition(
            "execution_route",
            "execution_workspace_prepare",
            "RunSpec.runtime_agent = pi / workspace_edit",
            "pi_workspace",
            "进入受治理pi隔离编辑",
        ),
        WorkflowEdgeDefinition(
            "execution_route",
            "pi_readonly_dispatch",
            "RunSpec.runtime_agent = pi / readonly",
            "pi_readonly",
            "进入受治理pi只读执行",
        ),
        WorkflowEdgeDefinition(
            "execution_route",
            "response_agent",
            "Default（RunSpec.runtime_agent = maf-workflow / answer_only）",
            "answer_only",
            "进入Chat回答Agent",
        ),
        WorkflowEdgeDefinition("execution_workspace_prepare", "pi_workspace_dispatch"),
        WorkflowEdgeDefinition("pi_workspace_dispatch", "pi_workspace_result_assembly"),
        WorkflowEdgeDefinition("pi_workspace_result_assembly", "turn_summary_agent"),
        WorkflowEdgeDefinition("pi_readonly_dispatch", "pi_readonly_result_assembly"),
        WorkflowEdgeDefinition("pi_readonly_result_assembly", "turn_summary_agent"),
        WorkflowEdgeDefinition("response_agent", "turn_summary_agent"),
        WorkflowEdgeDefinition("turn_summary_agent", "result_commit"),
        WorkflowEdgeDefinition("project_catalog_query", "result_commit"),
        WorkflowEdgeDefinition("result_commit", "work_state_commit"),
        WorkflowEdgeDefinition("work_state_commit", "memory_commit"),
        WorkflowEdgeDefinition("memory_commit", "harness_candidate_commit"),
        WorkflowEdgeDefinition("harness_candidate_commit", "turn_summary_persist"),
        WorkflowEdgeDefinition("clarification", "turn_summary_persist"),
        WorkflowEdgeDefinition("turn_summary_persist", "result_finalization"),
    ),
    selectable=True,
)


NESTED_QUALITY_WORKFLOW = WorkflowDefinition(
    id="nested-quality-demo",
    name="嵌套质量检查",
    version="1.0.0",
    description="用真实MAF Workflow演示异构Executor、两层子Workflow、成功与失败进度。",
    endpoint="/api/workflows/nested-quality-demo/run",
    nodes=(
        WorkflowNodeDefinition(
            id="intake",
            label="接收输入",
            description="从当前Product Session输入中取得最新用户请求。",
            kind="input",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="quality_gate",
            label="质量检查子流程",
            description="运行第1层嵌套MAF Workflow。",
            kind="workflow",
            runtime_type="workflow",
        ),
        WorkflowNodeDefinition(
            id="quality_gate.normalize",
            label="规范化",
            description="清理并规范化请求文本。",
            kind="transform",
            runtime_type="executor",
            parent_id="quality_gate",
            depth=1,
        ),
        WorkflowNodeDefinition(
            id="quality_gate.policy_bundle",
            label="策略包子流程",
            description="运行第2层嵌套MAF Workflow。",
            kind="workflow",
            runtime_type="workflow",
            parent_id="quality_gate",
            depth=1,
        ),
        WorkflowNodeDefinition(
            id="quality_gate.policy_bundle.rules",
            label="规则检查",
            description="执行确定性规则检查。",
            kind="policy",
            runtime_type="executor",
            parent_id="quality_gate.policy_bundle",
            depth=2,
        ),
        WorkflowNodeDefinition(
            id="quality_gate.policy_bundle.score",
            label="风险评分",
            description="形成可解释的确定性评分；输入含[fail]时注入失败。",
            kind="decision",
            runtime_type="executor",
            parent_id="quality_gate.policy_bundle",
            depth=2,
        ),
        WorkflowNodeDefinition(
            id="quality_gate.decide",
            label="质量结论",
            description="汇总子流程结果。",
            kind="decision",
            runtime_type="executor",
            parent_id="quality_gate",
            depth=1,
        ),
        WorkflowNodeDefinition(
            id="finalize",
            label="提交结果",
            description="生成产品可见结果，并经过Product Finalization Gate提交。",
            kind="output",
            runtime_type="executor",
        ),
    ),
    edges=(
        WorkflowEdgeDefinition("intake", "quality_gate"),
        WorkflowEdgeDefinition("quality_gate.normalize", "quality_gate.policy_bundle"),
        WorkflowEdgeDefinition("quality_gate.policy_bundle.rules", "quality_gate.policy_bundle.score"),
        WorkflowEdgeDefinition("quality_gate.policy_bundle", "quality_gate.decide"),
        WorkflowEdgeDefinition("quality_gate", "finalize"),
    ),
)

GOVERNED_AGENT_HANDOFF_WORKFLOW = WorkflowDefinition(
    id="governed-agent-handoff",
    name="双 Agent 会话传递",
    version="1.0.0",
    description="规划Agent生成草稿，确定性交接节点传递完整会话，审校Agent形成最终答复；两次模型调用分别审批。",
    endpoint="/api/workflows/governed-agent-handoff/run",
    nodes=(
        WorkflowNodeDefinition(
            id="planner",
            label="规划 Agent",
            description="读取Product Session完整上下文并生成方案草稿；调用前必须审批。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="handoff",
            label="会话交接",
            description="确定性地保留原始会话、规划结果和交接要求，不调用模型。",
            kind="handoff",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="reviewer",
            label="审校 Agent",
            description="复核原始目标和规划结果并形成最终答复；调用前再次审批。",
            kind="agent",
            runtime_type="agent",
        ),
    ),
    edges=(
        WorkflowEdgeDefinition("planner", "handoff"),
        WorkflowEdgeDefinition("handoff", "reviewer"),
    ),
)

GOVERNED_IDIOM_CHAIN_WORKFLOW = WorkflowDefinition(
    id="governed-idiom-chain",
    name="三方成语接龙",
    version="1.0.0",
    description="你先出一个四字成语，两位Agent依次接龙；两次真实模型调用分别暂停审批。",
    endpoint="/api/workflows/governed-idiom-chain/run",
    nodes=(
        WorkflowNodeDefinition(
            id="idiom_input",
            label="接收并校验你的成语",
            description="提取本轮四字成语，并校验是否承接上一轮末字。",
            kind="input",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="idiom_agent_a",
            label="接龙 Agent 甲",
            description="根据你的成语给出下一棒；模型请求发送前单独审批。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="idiom_handoff",
            label="传递下一棒",
            description="确定性传递三方接龙状态，不调用模型。",
            kind="handoff",
            runtime_type="executor",
        ),
        WorkflowNodeDefinition(
            id="idiom_agent_b",
            label="接龙 Agent 乙",
            description="承接Agent甲给出第三个成语；模型请求发送前再次审批。",
            kind="agent",
            runtime_type="agent",
        ),
        WorkflowNodeDefinition(
            id="idiom_result",
            label="汇总本轮并轮到你",
            description="形成三方公开结果，并明确下一轮应使用的开头字。",
            kind="output",
            runtime_type="executor",
        ),
    ),
    edges=(
        WorkflowEdgeDefinition("idiom_input", "idiom_agent_a"),
        WorkflowEdgeDefinition("idiom_agent_a", "idiom_handoff"),
        WorkflowEdgeDefinition("idiom_handoff", "idiom_agent_b"),
        WorkflowEdgeDefinition("idiom_agent_b", "idiom_result"),
    ),
    selectable=False,
)

GOVERNED_PI_AGENT_WORKFLOW = WorkflowDefinition(
    id="governed-pi-agent",
    name="pi Agent 受控工具",
    version="1.0.0",
    description=(
        "通过pi官方JSONL RPC运行编码Agent；每次Provider请求和每个pi内部Tool调用"
        "都在Chat的MAF Workflow中暂停、可编辑并重新审批。"
    ),
    endpoint="/api/workflows/governed-pi-agent/run",
    nodes=(
        WorkflowNodeDefinition(
            id="pi_agent",
            label="pi Agent Tool",
            description="启动隔离的pi RPC子进程，统计模型、Token、耗时和Tool事件。",
            kind="tool",
            runtime_type="tool",
        ),
        WorkflowNodeDefinition(
            id="pi_agent.model_gate",
            label="Provider请求审批",
            description="pi的每一次模型调用都显示完整请求，修改后绑定新Hash。",
            kind="approval",
            runtime_type="approval",
            parent_id="pi_agent",
            depth=1,
        ),
        WorkflowNodeDefinition(
            id="pi_agent.tool_gate",
            label="pi内部Tool审批",
            description="只允许服务端配置中存在的Tool；参数可见、可改、可放弃。",
            kind="approval",
            runtime_type="approval",
            parent_id="pi_agent",
            depth=1,
        ),
    ),
    edges=(
        WorkflowEdgeDefinition("pi_agent", "pi_agent.model_gate"),
        WorkflowEdgeDefinition("pi_agent", "pi_agent.tool_gate"),
    ),
)

WORKFLOW_CATALOG: tuple[WorkflowDefinition, ...] = (
    CONTINUOUS_COLLABORATION_WORKFLOW,
    CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    GOVERNED_IDIOM_CHAIN_WORKFLOW,
    GOVERNED_PI_AGENT_WORKFLOW,
)


def workflow_catalog_view(
    definitions: tuple[WorkflowDefinition, ...] = WORKFLOW_CATALOG,
) -> list[dict[str, object]]:
    return [workflow.view() for workflow in definitions]

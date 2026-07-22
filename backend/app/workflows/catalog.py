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
    selectable=True,
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

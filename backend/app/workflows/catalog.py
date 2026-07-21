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

    def view(self) -> dict[str, object]:
        return asdict(self)


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

WORKFLOW_CATALOG: tuple[WorkflowDefinition, ...] = (
    NESTED_QUALITY_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
)


def workflow_catalog_view(
    definitions: tuple[WorkflowDefinition, ...] = WORKFLOW_CATALOG,
) -> list[dict[str, object]]:
    return [workflow.view() for workflow in definitions]

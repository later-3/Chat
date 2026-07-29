"""持续协作主Workflow的唯一教学阶段事实。

这里的``S1``到``S7``只是帮助人阅读39个真实MAF节点的**学习分组**：

* 不是``PROJECT_PLAN``里的产品交付阶段0-8；
* 不是ContextPackage的``directory/detail``装配阶段；
* 不是单模型审批Workflow的1个MAF节点在前端展开的12个代码阶段；
* 也不是某次Product Run实际经过的分支路径。

节点和边的执行事实仍由``workflows/catalog.py``与
``workflows/continuous_chat_factory.py``拥有。本模块只给每个节点分配一个稳定、无重叠的
教学位置，供代码注释、人读Trace和项目掌握文档共同引用；测试会把它与当前Workflow Definition
逐项核对，防止文档继续出现“6阶段/7阶段、名字还对不上”的漂移。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ContinuousWorkflowLearningStage:
    """一个教学阶段的稳定说明；它不参与MAF图执行或Product状态转换。"""

    id: str
    name: str
    purpose: str
    input_summary: str
    output_summary: str
    node_ids: tuple[str, ...]

    @property
    def label(self) -> str:
        """返回Trace和文档统一使用的短标签。"""

        return f"学习阶段{self.id}：{self.name}"


CONTINUOUS_WORKFLOW_LEARNING_STAGES: tuple[ContinuousWorkflowLearningStage, ...] = (
    ContinuousWorkflowLearningStage(
        id="S1",
        name="输入接纳与目录级上下文",
        purpose="保存本轮输入证据，并从有界摘要和正式Project目录形成可审核的轻量Context。",
        input_summary="AG-UI消息、最近TurnSummary、未回答澄清与Harness轻量目录",
        output_summary="最新directory ContextPackage revision及其采用来源",
        node_ids=(
            "input_acceptance",
            "context_candidates",
            "harness_directory_context",
            "context_adoption",
            "directory_context_revision",
        ),
    ),
    ContinuousWorkflowLearningStage(
        id="S2",
        name="意图、Project绑定与详情上下文",
        purpose="把自然语言目标变成版本化Intent，绑定权威Project/Work，再装配有界工作集与协作协议。",
        input_summary="directory Context、用户原话与Harness正式资源",
        output_summary="已接受Intent Set、Project/Work绑定、detail Context revision与协议revision",
        node_ids=(
            "intent_agent",
            "intent_set_projection",
            "intent_binding",
            "intent_set_acceptance",
            "harness_project_resolver",
            "project_work_binding",
            "harness_detail_context",
            "detail_context_adoption",
            "detail_context_revision",
            "collaboration_protocol_resolver",
        ),
    ),
    ContinuousWorkflowLearningStage(
        id="S3",
        name="场景路由与可选规划",
        purpose="根据已接受意图选择确定性查询、澄清、规划或直接进入执行合同，不让下游重新猜用户意图。",
        input_summary="Intent Set、Project/Work绑定、detail Context与协作协议",
        output_summary="场景分支结果，或经过审核的本轮Plan候选",
        node_ids=(
            "scenario_router",
            "project_catalog_query",
            "clarification",
            "planning_agent",
            "plan_acceptance",
        ),
    ),
    ContinuousWorkflowLearningStage(
        id="S4",
        name="执行草稿、授权与运行路由",
        purpose="把目标和计划编译成可编辑ExecutionDraft，经授权冻结为RunSpec，再选择唯一执行分支。",
        input_summary="已接受目标、Context、Plan、能力、策略与Validation Contract",
        output_summary="不可变RunSpec以及answer_only、pi_readonly或pi_workspace路由",
        node_ids=(
            "execution_draft_compiler",
            "execution_authorization",
            "run_spec_compiler",
            "execution_route",
        ),
    ),
    ContinuousWorkflowLearningStage(
        id="S5",
        name="pi执行、Workspace与Evidence",
        purpose="按RunSpec执行只读或隔离编辑；可写结果还必须形成Artifact、Claim和Validation证据链。",
        input_summary="不可变RunSpec、Repository Snapshot、Tool授权与执行配置",
        output_summary="只读结果，或隔离Workspace结果及已决定的Completion Claim",
        node_ids=(
            "execution_workspace_prepare",
            "pi_workspace_dispatch",
            "pi_workspace_result_assembly",
            "result_claim_prepare",
            "result_claim_decision",
            "pi_readonly_dispatch",
            "pi_readonly_result_assembly",
        ),
    ),
    ContinuousWorkflowLearningStage(
        id="S6",
        name="响应、摘要与提交决定",
        purpose="形成可见答复和回合摘要候选，分别治理Result、Work状态与长期Memory的提交后果。",
        input_summary="直接回答或执行结果、当前Work与Memory候选",
        output_summary="经决定的Result、Work和Memory候选及其Decision记录",
        node_ids=(
            "response_agent",
            "turn_summary_agent",
            "result_commit",
            "work_state_commit",
            "memory_commit",
        ),
    ),
    ContinuousWorkflowLearningStage(
        id="S7",
        name="产品事实写入与本轮终态",
        purpose="幂等提交获准候选、保存可追溯TurnSummary，并把答复交给图外Product Finalization Gate。",
        input_summary="已决定的Result、Work、Memory候选和回合摘要",
        output_summary="Harness产品事实、TurnSummary、Assistant输出及终态双Trace",
        node_ids=(
            "harness_candidate_commit",
            "turn_summary_persist",
            "result_finalization",
        ),
    ),
)


def _build_node_stage_map() -> dict[str, ContinuousWorkflowLearningStage]:
    """构造节点到教学阶段的唯一映射；重复节点在应用导入时立即失败。"""

    result: dict[str, ContinuousWorkflowLearningStage] = {}
    for stage in CONTINUOUS_WORKFLOW_LEARNING_STAGES:
        for node_id in stage.node_ids:
            if node_id in result:
                raise RuntimeError(f"Workflow学习阶段重复登记节点：{node_id}")
            result[node_id] = stage
    return result


CONTINUOUS_NODE_LEARNING_STAGES = _build_node_stage_map()
CONTINUOUS_NODE_LEARNING_STAGE_LABELS = {
    node_id: stage.label for node_id, stage in CONTINUOUS_NODE_LEARNING_STAGES.items()
}

import { ChevronDown, Code2, Eye, LocateFixed, Minimize2, Route, Rows3 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { nodeContentFromTrace, progressFromTrace } from "../../workflow-progress.js";
import type { GovernedReviewCard } from "../chat/chat-agent-contracts.js";
import type {
  ProductTraceEvent,
  RunGovernanceView,
  StepInputProjection,
  WorkflowDefinition,
  WorkflowNodeStatus,
} from "./workflow-api.js";
import { WorkflowMindMap } from "./workflow-mind-map.js";
import { routeDecisionsFromTrace, unselectedBranchNodeIds } from "./workflow-route-projection.js";
import {
  formatOccurredAt,
  governanceForNode,
  NODE_STATUS_LABELS,
  NodeDetail,
  StageIcon,
  stepInputForNode,
} from "./workflow-run-content.js";

const KIND_LABELS: Record<string, string> = {
  input: "输入 Executor",
  output: "输出 Executor",
  agent: "受治理 Agent",
  context: "上下文 Executor",
  decision: "分支选择 Executor",
  governance: "治理 Executor",
  transform: "转换 Executor",
  handoff: "确定性交接",
  approval: "审批 Executor",
  workflow: "MAF Workflow",
  tool: "Tool",
};

export function GenericWorkflowChain({
  workflow,
  trace,
  pendingReview,
  governance,
  stepInputs,
}: {
  workflow: WorkflowDefinition;
  trace: ProductTraceEvent[];
  pendingReview: GovernedReviewCard | null;
  governance: RunGovernanceView | null;
  stepInputs: StepInputProjection[];
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [showLedger, setShowLedger] = useState(false);
  const nodeElements = useRef(new Map<string, HTMLElement>());
  const progress = useMemo(() => progressFromTrace(workflow, trace), [trace, workflow]);
  const contents = useMemo(() => nodeContentFromTrace(workflow, trace), [trace, workflow]);
  const routeDecisions = useMemo(() => routeDecisionsFromTrace(workflow, trace), [trace, workflow]);
  const unselectedBranchNodes = useMemo(
    () => unselectedBranchNodeIds(workflow, trace, routeDecisions),
    [routeDecisions, trace, workflow],
  );
  const nodesWithContent = workflow.nodes.filter((node) => Boolean(contents[node.id]));
  const waitingExecutor =
    pendingReview?.execution_context.executor_id ??
    (pendingReview && "agent_id" in pendingReview.execution_context
      ? pendingReview.execution_context.agent_id
      : undefined);
  const attentionNode = workflow.nodes.find((node) => {
    const status = progress[node.id].status;
    return (
      waitingExecutor === node.id ||
      status === "in_progress" ||
      status === "failed" ||
      status === "abandoned"
    );
  });

  const toggleNode = (nodeId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const locateAttentionNode = () => {
    if (!attentionNode) return;
    setExpandedIds((current) => new Set(current).add(attentionNode.id));
    window.requestAnimationFrame(() => {
      const element = nodeElements.current.get(attentionNode.id);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.querySelector<HTMLButtonElement>(".execution-stage-toggle")?.focus();
    });
  };

  return (
    <section className="execution-chain" aria-label="MAF Workflow节点">
      <header className="execution-chain-heading">
        <div>
          <Route size={18} />
          <strong>真实 MAF Workflow</strong>
        </div>
        <span>
          {workflow.nodes.length} 个节点 · {Object.values(contents).filter(Boolean).length}{" "}
          个已有公开内容
        </span>
      </header>
      <WorkflowMindMap
        governance={governance}
        pendingReview={pendingReview}
        stepInputs={stepInputs}
        trace={trace}
        workflow={workflow}
      />
      <div className="execution-ledger-heading">
        <div>
          <Rows3 size={17} />
          <span>
            <small>完整 Definition</small>
            <strong>全部节点台账</strong>
          </span>
        </div>
        <button
          aria-expanded={showLedger}
          onClick={() => setShowLedger((current) => !current)}
          type="button"
        >
          {showLedger ? <Minimize2 size={15} /> : <ChevronDown size={15} />}
          {showLedger ? "收起节点台账" : `查看全部 ${workflow.nodes.length} 个节点`}
        </button>
      </div>
      {showLedger && (
        <>
          <div className="execution-chain-actions" aria-label="节点查看操作" role="toolbar">
            <button disabled={!attentionNode} onClick={locateAttentionNode} type="button">
              <LocateFixed size={15} />
              定位当前节点
            </button>
            <button
              disabled={nodesWithContent.length === 0}
              onClick={() => setExpandedIds(new Set(nodesWithContent.map((node) => node.id)))}
              type="button"
            >
              <Rows3 size={15} />
              展开有内容（{nodesWithContent.length}）
            </button>
            <button
              disabled={expandedIds.size === 0}
              onClick={() => setExpandedIds(new Set())}
              type="button"
            >
              <Minimize2 size={15} />
              收起内容
            </button>
          </div>
          <div className="execution-stage-list execution-stage-list--workflow-nodes">
            {workflow.nodes.map((node, index) => {
              const nodeProgress = progress[node.id];
              const waiting = waitingExecutor === node.id && nodeProgress.status === "in_progress";
              const branchNotSelected =
                nodeProgress.status === "idle" && unselectedBranchNodes.has(node.id);
              const status: WorkflowNodeStatus = waiting
                ? "waiting_approval"
                : branchNotSelected
                  ? "skipped"
                  : nodeProgress.status;
              const content = contents[node.id];
              const expanded = expandedIds.has(node.id);
              return (
                <article
                  className={`execution-stage execution-stage--${status} execution-stage--kind-${node.kind} ${expanded ? "execution-stage--expanded" : ""}`}
                  key={node.id}
                  ref={(element) => {
                    if (element) nodeElements.current.set(node.id, element);
                    else nodeElements.current.delete(node.id);
                  }}
                >
                  <button
                    aria-expanded={expanded}
                    className="execution-stage-toggle"
                    onClick={() => toggleNode(node.id)}
                    type="button"
                  >
                    <span className="execution-stage-rail" aria-hidden="true">
                      <span className="execution-stage-number">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="execution-stage-icon">
                        <StageIcon status={status} />
                      </span>
                    </span>
                    <span className="execution-stage-copy">
                      <span className="execution-stage-title">
                        <strong>{node.label}</strong>
                        <span
                          className={`execution-stage-status execution-stage-status--${status}`}
                        >
                          {branchNotSelected ? "分支未选择" : NODE_STATUS_LABELS[status]}
                        </span>
                      </span>
                      <span className="execution-stage-description">{node.description}</span>
                      <span className="execution-stage-meta">
                        <span>{KIND_LABELS[node.kind] ?? node.kind}</span>
                        <span>executor_id: {node.id}</span>
                        {content && (
                          <time dateTime={content.occurredAt}>
                            {formatOccurredAt(content.occurredAt)}
                          </time>
                        )}
                      </span>
                      <span className="execution-stage-source">
                        <Code2 size={14} />
                        <code>
                          {workflow.id === "continuous-collaboration"
                            ? "workflows/continuous_chat.py"
                            : `workflows/${workflow.id.replaceAll("-", "_")}.py`}{" "}
                          · {node.id}
                        </code>
                      </span>
                    </span>
                    <span className="execution-stage-expand">
                      <Eye size={15} />
                      {expanded ? "收起内容" : "查看内容"}
                      <ChevronDown size={15} />
                    </span>
                  </button>
                  {expanded && (
                    <NodeDetail
                      facts={{
                        executor_id: node.id,
                        actor: content?.actor,
                        content_type: content?.contentType,
                        status: branchNotSelected ? "分支未选择" : NODE_STATUS_LABELS[status],
                        trace_sequence: content?.sequence,
                      }}
                      governance={governanceForNode(node.id, governance)}
                      input={content?.publicInput}
                      output={content?.publicOutput}
                      stepInput={stepInputForNode(node.id, stepInputs)}
                    />
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

import {
  Check,
  CircleSlash2,
  GitBranch,
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
  Route,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { nodeContentFromTrace, progressFromTrace } from "../../workflow-progress.js";
import type { GovernedReviewCard } from "../chat/chat-agent-contracts.js";
import type {
  ProductTraceEvent,
  RunGovernanceView,
  StepInputProjection,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeStatus,
} from "./workflow-api.js";
import { buildMindMapProjection } from "./workflow-mind-map-projection.js";
import {
  routeDecisionsFromTrace,
  unselectedBranchNodeIds,
  type WorkflowPathNode,
} from "./workflow-route-projection.js";
import {
  formatOccurredAt,
  governanceForNode,
  NODE_STATUS_LABELS,
  NodeDetail,
  StageIcon,
  stepInputForNode,
} from "./workflow-run-content.js";

const ZOOM_LEVELS = [1, 1.12, 1.24] as const;

const KIND_LABELS: Record<string, string> = {
  input: "输入",
  output: "输出",
  agent: "Agent",
  context: "上下文",
  decision: "选择",
  governance: "治理",
  transform: "转换",
  handoff: "交接",
  approval: "审批",
  workflow: "子Workflow",
  tool: "Tool",
};

function displayActual(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未设置";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function statusForNode({
  nodeId,
  progress,
  waitingExecutor,
  unselectedNodes,
}: {
  nodeId: string;
  progress: ReturnType<typeof progressFromTrace>;
  waitingExecutor: string | undefined;
  unselectedNodes: Set<string>;
}): WorkflowNodeStatus {
  const nodeProgress = progress[nodeId];
  if (waitingExecutor === nodeId && nodeProgress.status === "in_progress") {
    return "waiting_approval";
  }
  if (nodeProgress.status === "idle" && unselectedNodes.has(nodeId)) return "skipped";
  return nodeProgress.status;
}

function MindMapNode({
  node,
  status,
  selected,
  onSelect,
}: {
  node: WorkflowNodeDefinition;
  status: WorkflowNodeStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-current={selected ? "step" : undefined}
      className={`workflow-mindmap-node workflow-mindmap-node--${status} ${
        selected ? "workflow-mindmap-node--selected" : ""
      }`}
      onClick={onSelect}
      type="button"
    >
      <span className="workflow-mindmap-node-icon" aria-hidden="true">
        <StageIcon status={status} />
      </span>
      <span>
        <small>{KIND_LABELS[node.kind] ?? node.kind}</small>
        <strong>{node.label}</strong>
      </span>
      <em>{status === "skipped" ? "未走" : NODE_STATUS_LABELS[status]}</em>
    </button>
  );
}

function MindMapNodeStack({
  eyebrow,
  label,
  nodes,
  workflow,
  progress,
  waitingExecutor,
  unselectedNodes,
  selectedNodeId,
  onSelectNode,
}: {
  eyebrow: string;
  label: string;
  nodes: WorkflowPathNode[];
  workflow: WorkflowDefinition;
  progress: ReturnType<typeof progressFromTrace>;
  waitingExecutor: string | undefined;
  unselectedNodes: Set<string>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <section className="workflow-mindmap-phase">
      <header>
        <span>{eyebrow}</span>
        <strong>{label}</strong>
        <small>{nodes.length} 个真实节点</small>
      </header>
      <ol>
        {nodes.map((pathNode) => {
          const node = workflow.nodes.find((candidate) => candidate.id === pathNode.id);
          if (!node) return null;
          return (
            <li key={node.id}>
              <MindMapNode
                node={node}
                onSelect={() => onSelectNode(node.id)}
                selected={selectedNodeId === node.id}
                status={statusForNode({
                  nodeId: node.id,
                  progress,
                  waitingExecutor,
                  unselectedNodes,
                })}
              />
            </li>
          );
        })}
      </ol>
      <footer>布局分组，不是额外 MAF 节点</footer>
    </section>
  );
}

export function WorkflowMindMap({
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
  const progress = useMemo(() => progressFromTrace(workflow, trace), [trace, workflow]);
  const contents = useMemo(() => nodeContentFromTrace(workflow, trace), [trace, workflow]);
  const projection = useMemo(() => buildMindMapProjection(workflow, trace), [trace, workflow]);
  const decisions = useMemo(() => routeDecisionsFromTrace(workflow, trace), [trace, workflow]);
  const unselectedNodes = useMemo(
    () => unselectedBranchNodeIds(workflow, trace, decisions),
    [decisions, trace, workflow],
  );
  const waitingExecutor =
    pendingReview?.execution_context.executor_id ??
    (pendingReview && "agent_id" in pendingReview.execution_context
      ? pendingReview.execution_context.agent_id
      : undefined);
  const attentionNode =
    workflow.nodes.find((node) => {
      const status = progress[node.id].status;
      return (
        waitingExecutor === node.id ||
        status === "in_progress" ||
        status === "failed" ||
        status === "abandoned"
      );
    }) ?? null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    projection.decision?.nodeId ?? attentionNode?.id ?? null,
  );
  const [zoomIndex, setZoomIndex] = useState(0);
  const selectedNode =
    workflow.nodes.find((node) => node.id === selectedNodeId) ??
    workflow.nodes.find((node) => node.id === projection.decision?.nodeId) ??
    null;
  const selectedContent = selectedNode ? contents[selectedNode.id] : undefined;
  const selectedStatus = selectedNode
    ? statusForNode({
        nodeId: selectedNode.id,
        progress,
        waitingExecutor,
        unselectedNodes,
      })
    : "idle";
  const decisionNode = projection.decision
    ? workflow.nodes.find((node) => node.id === projection.decision?.nodeId)
    : null;

  useEffect(() => {
    if (selectedNodeId && workflow.nodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(
      projection.decision?.nodeId ??
        attentionNode?.id ??
        projection.beforeDecision.at(-1)?.id ??
        null,
    );
  }, [
    attentionNode?.id,
    projection.beforeDecision,
    projection.decision?.nodeId,
    selectedNodeId,
    workflow.nodes,
  ]);

  const resetZoom = () => setZoomIndex(0);
  const selectAttention = () => {
    if (attentionNode) setSelectedNodeId(attentionNode.id);
  };

  return (
    <section className="workflow-mindmap" aria-label="Workflow思维导图">
      <header className="workflow-mindmap-toolbar">
        <div>
          <Route size={19} />
          <span>
            <small>DEFINITION + TRACE</small>
            <strong>Workflow 思维导图</strong>
          </span>
        </div>
        <div className="workflow-mindmap-toolbar-actions">
          <button disabled={!attentionNode} onClick={selectAttention} type="button">
            <LocateFixed size={15} />
            当前节点
          </button>
          <button
            aria-label="缩小工作流图"
            disabled={zoomIndex === 0}
            onClick={() => setZoomIndex((current) => Math.max(0, current - 1))}
            type="button"
          >
            <Minus size={15} />
          </button>
          <span>{Math.round(ZOOM_LEVELS[zoomIndex] * 100)}%</span>
          <button
            aria-label="放大工作流图"
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
            onClick={() => setZoomIndex((current) => Math.min(ZOOM_LEVELS.length - 1, current + 1))}
            type="button"
          >
            <Plus size={15} />
          </button>
          <button onClick={resetZoom} type="button">
            <RotateCcw size={15} />
            重置比例
          </button>
        </div>
      </header>

      <section className="workflow-mindmap-legend" aria-label="工作流图例">
        <span>
          <i className="workflow-mindmap-legend-dot workflow-mindmap-legend-dot--selected" />
          本轮实际路径
        </span>
        <span>
          <i className="workflow-mindmap-legend-dot workflow-mindmap-legend-dot--unselected" />
          本轮未选择
        </span>
        <span>
          <GitBranch size={14} />
          选择节点按声明顺序首个命中
        </span>
      </section>

      <div className="workflow-mindmap-viewport">
        <div
          className={`workflow-mindmap-canvas ${
            projection.decision ? "" : "workflow-mindmap-canvas--linear"
          }`}
          style={{ zoom: ZOOM_LEVELS[zoomIndex] }}
        >
          <MindMapNodeStack
            eyebrow="UPSTREAM"
            label={projection.decision ? "进入选择前" : "本次实际路径"}
            nodes={projection.beforeDecision}
            onSelectNode={setSelectedNodeId}
            progress={progress}
            selectedNodeId={selectedNodeId}
            unselectedNodes={unselectedNodes}
            waitingExecutor={waitingExecutor}
            workflow={workflow}
          />

          {projection.decision && decisionNode && (
            <>
              <div className="workflow-mindmap-connector workflow-mindmap-connector--selected">
                <span>进入选择</span>
              </div>
              <section className="workflow-mindmap-decision">
                <span className="workflow-mindmap-decision-kind">
                  <GitBranch size={16} />
                  真实选择节点
                </span>
                <MindMapNode
                  node={decisionNode}
                  onSelect={() => setSelectedNodeId(decisionNode.id)}
                  selected={selectedNodeId === decisionNode.id}
                  status={statusForNode({
                    nodeId: decisionNode.id,
                    progress,
                    waitingExecutor,
                    unselectedNodes,
                  })}
                />
                <p>{projection.decision.selectionReason}</p>
                <code>{projection.decision.selectionMode} · 按声明顺序</code>
              </section>

              <section className="workflow-mindmap-branches" aria-label="选择节点候选分支">
                <header>
                  <span>4 条候选边</span>
                  <strong>本轮选择依据</strong>
                </header>
                <ol>
                  {projection.decision.options.map((option, index) => {
                    const targetNode = workflow.nodes.find((node) => node.id === option.target);
                    if (!targetNode) return null;
                    return (
                      <li
                        className={
                          option.selected
                            ? "workflow-mindmap-branch workflow-mindmap-branch--selected"
                            : "workflow-mindmap-branch"
                        }
                        key={option.branchId}
                      >
                        <span className="workflow-mindmap-branch-line" aria-hidden="true" />
                        <button
                          className="workflow-mindmap-branch-card"
                          onClick={() => setSelectedNodeId(targetNode.id)}
                          type="button"
                        >
                          <span className="workflow-mindmap-branch-order">{index + 1}</span>
                          <span className="workflow-mindmap-branch-copy">
                            <span>
                              <strong>{option.label}</strong>
                              <em>{option.selected ? "本轮命中" : "本轮未走"}</em>
                            </span>
                            <code>{option.condition}</code>
                            <small>实际值：{displayActual(option.actual)}</small>
                            <p>{option.reason}</p>
                          </span>
                          <span className="workflow-mindmap-branch-status" aria-hidden="true">
                            {option.selected ? <Check size={17} /> : <CircleSlash2 size={16} />}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                <footer>
                  {projection.decision.evidence === "persisted_evaluation"
                    ? "依据：本轮 Trace 持久化的公开求值"
                    : "兼容投影：旧 Trace 只保存最终分支"}
                </footer>
              </section>

              <div className="workflow-mindmap-connector workflow-mindmap-connector--selected">
                <span>沿选中分支继续</span>
              </div>
              <MindMapNodeStack
                eyebrow="DOWNSTREAM"
                label="选中路径后续"
                nodes={projection.afterSelectedTarget}
                onSelectNode={setSelectedNodeId}
                progress={progress}
                selectedNodeId={selectedNodeId}
                unselectedNodes={unselectedNodes}
                waitingExecutor={waitingExecutor}
                workflow={workflow}
              />
            </>
          )}
        </div>
      </div>

      {selectedNode && (
        <section className="workflow-mindmap-inspector" aria-label="当前选中节点内容">
          <header>
            <span>
              <small>当前选中节点</small>
              <strong>{selectedNode.label}</strong>
            </span>
            <em className={`execution-stage-status execution-stage-status--${selectedStatus}`}>
              {selectedStatus === "skipped" ? "分支未选择" : NODE_STATUS_LABELS[selectedStatus]}
            </em>
          </header>
          <p>{selectedNode.description}</p>
          <NodeDetail
            facts={{
              executor_id: selectedNode.id,
              actor: selectedContent?.actor,
              content_type: selectedContent?.contentType,
              status:
                selectedStatus === "skipped" ? "分支未选择" : NODE_STATUS_LABELS[selectedStatus],
              trace_sequence: selectedContent?.sequence,
              occurred_at: selectedContent
                ? formatOccurredAt(selectedContent.occurredAt)
                : undefined,
            }}
            governance={governanceForNode(selectedNode.id, governance)}
            input={selectedContent?.publicInput}
            output={selectedContent?.publicOutput}
            stepInput={stepInputForNode(selectedNode.id, stepInputs)}
          />
        </section>
      )}
    </section>
  );
}

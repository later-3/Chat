import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Code2,
  Database,
  Eye,
  LoaderCircle,
  Minus,
  PanelRightClose,
  Radio,
  Route,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ProductRun } from "./session-api.js";
import type { GovernedReviewCard, ModelCallReviewCard, RunStatus } from "./use-chat-agent.js";
import {
  getRunGovernance,
  getRunTrace,
  type ProductTraceEvent,
  type RunGovernanceView,
  type WorkflowDefinition,
  type WorkflowNodeStatus,
} from "./workflow-api.js";
import { nodeContentFromTrace, progressFromTrace } from "./workflow-progress.js";
import {
  CHAT_WORKFLOW,
  deriveWorkflowRunProjection,
  WORKFLOW_STAGE_GROUPS,
  type WorkflowStageGroup,
  type WorkflowStageProjection,
  type WorkflowStageStatus,
} from "./workflow-run-projection.js";

interface WorkflowRunViewProps {
  workflow: WorkflowDefinition;
  latestRun: ProductRun | null;
  pendingReview: GovernedReviewCard | null;
  prompt: string | null;
  assistantOutput: string | null;
  runStatus: RunStatus;
  onClose: () => void;
}

const STAGE_STATUS_LABELS: Record<WorkflowStageStatus, string> = {
  not_started: "未开始",
  in_progress: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "未完成",
  abandoned: "已放弃",
  skipped: "已跳过",
};

const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  idle: "未开始",
  in_progress: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "未完成",
  abandoned: "已放弃",
  skipped: "已跳过",
};

const GROUP_ICONS: Record<WorkflowStageGroup, typeof Route> = {
  ingress: Route,
  maf: Workflow,
  provider: Radio,
  finalization: Database,
};

const KIND_LABELS: Record<string, string> = {
  input: "输入 Executor",
  output: "输出 Executor",
  agent: "受治理 Agent",
  handoff: "确定性交接",
  approval: "审批 Executor",
  workflow: "MAF Workflow",
  tool: "Tool",
};

function StageIcon({ status }: { status: WorkflowStageStatus | WorkflowNodeStatus }) {
  if (status === "in_progress") return <LoaderCircle className="workflow-spin" size={17} />;
  if (status === "completed") return <Check size={17} />;
  if (status === "waiting_approval") return <Clock3 size={17} />;
  if (status === "failed" || status === "abandoned") return <AlertTriangle size={17} />;
  if (status === "skipped") return <Minus size={17} />;
  return <Circle size={15} />;
}

function formatOccurredAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <p className="node-public-empty">尚未产生</p>;
  }
  if (typeof value === "string") return <p className="node-public-text">{value}</p>;
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="node-public-text">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ol className="node-public-list">
        {value.map((item, index) => <li key={index}><ReadableValue value={item} /></li>)}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="node-public-fields">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}><dt>{key}</dt><dd><ReadableValue value={item} /></dd></div>
        ))}
      </dl>
    );
  }
  return <p className="node-public-text">{String(value)}</p>;
}

interface StageContent {
  input: unknown;
  output: unknown;
  facts: Record<string, unknown>;
  governance?: unknown;
}

function publicContentForStage(
  stage: WorkflowStageProjection,
  prompt: string | null,
  assistantOutput: string | null,
  latestRun: ProductRun | null,
  pendingReview: ModelCallReviewCard | null,
): StageContent {
  const requestModel = typeof pendingReview?.provider_request.model === "string"
    ? pendingReview.provider_request.model
    : latestRun?.model;
  const draftFacts = pendingReview ? {
    draft_version: pendingReview.version,
    binding_hash: pendingReview.binding_hash,
    provider: pendingReview.provider_id,
    model: requestModel,
  } : {};
  const baseFacts = {
    status: STAGE_STATUS_LABELS[stage.status],
    layer: stage.layer,
    runtime_type: stage.runtimeType,
    occurred_at: formatOccurredAt(stage.occurredAt),
    ...stage.details,
  };
  switch (stage.id) {
    case "agui.ingress":
      return { input: prompt, output: { thread_id: latestRun?.session_id, agui_run_id: latestRun?.agui_run_id }, facts: baseFacts };
    case "product.prepare":
      return { input: prompt, output: { product_run_id: latestRun?.id, status: latestRun?.status }, facts: baseFacts };
    case "maf.enter":
      return { input: prompt, output: "进入 chat-model-call-approval Workflow", facts: baseFacts };
    case "request.compile":
      return { input: prompt, output: draftFacts, facts: baseFacts };
    case "approval.wait":
      return { input: draftFacts, output: pendingReview ? "等待你确认、修改或放弃" : STAGE_STATUS_LABELS[stage.status], facts: baseFacts };
    case "approval.claim":
      return { input: draftFacts, output: stage.status === "completed" ? "已锁定唯一审批版本" : null, facts: baseFacts };
    case "provider.dispatch":
      return { input: pendingReview ? "尚未发送；完整请求在审批界面中" : draftFacts, output: stage.status === "completed" ? "请求已到达 Provider" : null, facts: baseFacts };
    case "provider.receive":
      return { input: "Provider 响应流", output: assistantOutput, facts: baseFacts };
    case "provider.decode":
      return { input: "Provider SSE / JSON 响应", output: assistantOutput, facts: baseFacts };
    case "agui.project":
      return { input: assistantOutput, output: "AG-UI 文本事件已投影到聊天区", facts: baseFacts };
    case "product.commit":
      return { input: assistantOutput, output: { assistant_message: assistantOutput, run_status: latestRun?.status }, facts: baseFacts };
    case "agui.terminal":
      return { input: latestRun?.status, output: `AG-UI Run ${latestRun?.status ?? "尚未结束"}`, facts: baseFacts };
  }
}

function NodeDetail({ input, output, facts, governance }: StageContent) {
  return (
    <div className="execution-node-detail">
      <section><span>公开输入</span><ReadableValue value={input} /></section>
      <section><span>公开输出</span><ReadableValue value={output} /></section>
      <section><span>运行事实</span><ReadableValue value={facts} /></section>
      {governance !== undefined && <section><span>治理与持久化事实</span><ReadableValue value={governance} /></section>}
      <p><ShieldCheck size={14} />这里只展示可审核的公开内容和运行事实，不保存或展示模型隐藏推理。</p>
    </div>
  );
}

export function governanceForNode(
  nodeId: string,
  governance: RunGovernanceView | null,
): unknown {
  if (!governance) return undefined;
  const evaluations = governance.policy_evaluations.filter((value) => value.workflow_node_id === nodeId);
  const decisionKeys = new Set(evaluations.map((value) => value.decision_point_key));
  const decisionRequests = governance.decision_requests.filter((value) => {
    const evidence = value.visible_evidence;
    const requestNode = typeof evidence === "object" && evidence !== null
      && typeof (evidence as Record<string, unknown>).workflow_node_id === "string"
      ? String((evidence as Record<string, unknown>).workflow_node_id)
      : null;
    if (requestNode !== null) return requestNode === nodeId;
    return typeof value.decision_point_key === "string" && decisionKeys.has(value.decision_point_key);
  });
  const modelCall = governance.model_calls.find((value) => value.workflow_node_id === nodeId);
  if (nodeId === "execution_draft_compiler") {
    return { ExecutionDraft: governance.execution_draft };
  }
  if (nodeId === "run_spec_compiler") {
    return { RunSpec: governance.run_spec };
  }
  if (nodeId === "turn_summary_persist") {
    return { TurnSummary: governance.turn_summary };
  }
  if (evaluations.length === 0 && decisionRequests.length === 0 && !modelCall) return undefined;
  return {
    ...(evaluations.length > 0 ? { PolicyEvaluations: evaluations } : {}),
    ...(decisionRequests.length > 0 ? { HumanDecisionRequests: decisionRequests } : {}),
    ...(modelCall ? { ModelCallDraft: modelCall } : {}),
  };
}

function StageRow({
  stage,
  number,
  expanded,
  onToggle,
  content,
}: {
  stage: WorkflowStageProjection;
  number: number;
  expanded: boolean;
  onToggle: () => void;
  content: StageContent;
}) {
  const occurredAt = formatOccurredAt(stage.occurredAt);
  return (
    <article className={`execution-stage execution-stage--${stage.status} ${expanded ? "execution-stage--expanded" : ""}`}>
      <button aria-expanded={expanded} className="execution-stage-toggle" onClick={onToggle} type="button">
        <span className="execution-stage-rail" aria-hidden="true">
          <span className="execution-stage-number">{String(number).padStart(2, "0")}</span>
          <span className="execution-stage-icon"><StageIcon status={stage.status} /></span>
        </span>
        <span className="execution-stage-copy">
          <span className="execution-stage-title">
            <strong>{stage.label}</strong>
            <span className={`execution-stage-status execution-stage-status--${stage.status}`}>
              {STAGE_STATUS_LABELS[stage.status]}
            </span>
          </span>
          <span className="execution-stage-description">{stage.description}</span>
          <span className="execution-stage-meta">
            <span>{stage.layer}</span>
            <span>{stage.runtimeType}</span>
            {occurredAt && <time dateTime={stage.occurredAt ?? undefined}>{occurredAt}</time>}
          </span>
          <span className="execution-stage-source"><Code2 size={14} /><code>{stage.source}</code></span>
        </span>
        <span className="execution-stage-expand"><Eye size={15} />查看内容<ChevronDown size={15} /></span>
      </button>
      {expanded && <NodeDetail {...content} />}
    </article>
  );
}

function GenericWorkflowChain({
  workflow,
  trace,
  pendingReview,
  governance,
}: {
  workflow: WorkflowDefinition;
  trace: ProductTraceEvent[];
  pendingReview: GovernedReviewCard | null;
  governance: RunGovernanceView | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const progress = useMemo(() => progressFromTrace(workflow, trace), [trace, workflow]);
  const contents = useMemo(() => nodeContentFromTrace(workflow, trace), [trace, workflow]);
  return (
    <section className="execution-chain" aria-label="MAF Workflow节点">
      <header className="execution-chain-heading">
        <div><Route size={18} /><strong>真实 MAF Workflow 节点</strong></div>
        <span>{workflow.nodes.length} 个节点 · {Object.values(contents).filter(Boolean).length} 个已有公开内容</span>
      </header>
      <div className="execution-stage-list execution-stage-list--workflow-nodes">
        {workflow.nodes.map((node, index) => {
          const nodeProgress = progress[node.id];
          const waitingExecutor = pendingReview?.execution_context.executor_id
            ?? (pendingReview && "agent_id" in pendingReview.execution_context ? pendingReview.execution_context.agent_id : undefined);
          const waiting = waitingExecutor === node.id && nodeProgress.status === "in_progress";
          const status: WorkflowNodeStatus = waiting ? "waiting_approval" : nodeProgress.status;
          const content = contents[node.id];
          const expanded = expandedId === node.id;
          return (
            <article className={`execution-stage execution-stage--${status} ${expanded ? "execution-stage--expanded" : ""}`} key={node.id}>
              <button
                aria-expanded={expanded}
                className="execution-stage-toggle"
                onClick={() => setExpandedId(expanded ? null : node.id)}
                type="button"
              >
                <span className="execution-stage-rail" aria-hidden="true">
                  <span className="execution-stage-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="execution-stage-icon"><StageIcon status={status} /></span>
                </span>
                <span className="execution-stage-copy">
                  <span className="execution-stage-title">
                    <strong>{node.label}</strong>
                    <span className={`execution-stage-status execution-stage-status--${status}`}>{NODE_STATUS_LABELS[status]}</span>
                  </span>
                  <span className="execution-stage-description">{node.description}</span>
                  <span className="execution-stage-meta">
                    <span>{KIND_LABELS[node.kind] ?? node.kind}</span>
                    <span>executor_id: {node.id}</span>
                    {content && <time dateTime={content.occurredAt}>{formatOccurredAt(content.occurredAt)}</time>}
                  </span>
                  <span className="execution-stage-source"><Code2 size={14} /><code>{workflow.id === "continuous-collaboration" ? "workflows/continuous_chat.py" : `workflows/${workflow.id.replaceAll("-", "_")}.py`} · {node.id}</code></span>
                </span>
                <span className="execution-stage-expand"><Eye size={15} />查看内容<ChevronDown size={15} /></span>
              </button>
              {expanded && (
                <NodeDetail
                  facts={{
                    executor_id: node.id,
                    actor: content?.actor,
                    content_type: content?.contentType,
                    status: NODE_STATUS_LABELS[status],
                    trace_sequence: content?.sequence,
                  }}
                  governance={governanceForNode(node.id, governance)}
                  input={content?.publicInput}
                  output={content?.publicOutput}
                />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function WorkflowRunView({
  workflow,
  latestRun,
  pendingReview,
  prompt,
  assistantOutput,
  runStatus,
  onClose,
}: WorkflowRunViewProps) {
  const [trace, setTrace] = useState<ProductTraceEvent[]>([]);
  const [governance, setGovernance] = useState<RunGovernanceView | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [expandedStageId, setExpandedStageId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!latestRun) {
      setTrace([]);
      setGovernance(null);
      setTraceError(null);
      return undefined;
    }
    const load = () => {
      void getRunTrace(latestRun.session_id, latestRun.id)
        .then((events) => {
          if (!cancelled) {
            setTrace(events);
            setTraceError(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setTraceError(error instanceof Error ? error.message : "Trace读取失败");
        });
      void getRunGovernance(latestRun.id)
        .then((value) => {
          if (!cancelled) setGovernance(value);
        })
        .catch(() => {
          // Older runs may predate the governance schema. Trace remains the
          // primary execution projection, so this optional detail fails soft.
          if (!cancelled) setGovernance(null);
        });
    };
    load();
    const active = ["running", "waiting_approval", "accepted", "committing"].includes(latestRun.status)
      || runStatus === "running"
      || runStatus === "saving"
      || runStatus === "awaiting_approval";
    const timer = active ? window.setInterval(load, 700) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [latestRun?.id, latestRun?.session_id, latestRun?.status, runStatus]);

  const projection = useMemo(
    () => deriveWorkflowRunProjection(runStatus, Boolean(pendingReview), latestRun, trace),
    [latestRun, pendingReview, runStatus, trace],
  );
  const modelReview: ModelCallReviewCard | null = pendingReview && pendingReview.review_kind !== "product_decision" && pendingReview.review_kind !== "tool_execution"
    ? pendingReview
    : null;
  const provider = modelReview?.provider_catalog.find((value) => value.id === modelReview.provider_id);
  const model = typeof modelReview?.provider_request.model === "string"
    ? modelReview.provider_request.model
    : latestRun?.model;
  const isCodeStageWorkflow = workflow.id === CHAT_WORKFLOW.id;

  return (
    <aside className="workbench" aria-label="Workflow Run 工作台">
      <header className="workbench-header">
        <div><p className="eyebrow">DESIGNER WORKBENCH</p><strong>代码执行链</strong></div>
        <button aria-label="关闭工作台" onClick={onClose} type="button"><PanelRightClose size={20} /></button>
      </header>

      <div className="workbench-body">
        <section className="run-summary-card">
          <div className="run-summary-heading">
            <span className="run-summary-icon"><Workflow size={22} /></span>
            <div><strong>{workflow.name}</strong><small>Workflow Definition · v{workflow.version}</small></div>
            <span className={`workflow-run-status workflow-run-status--${projection.status}`}>{projection.statusLabel}</span>
          </div>
          <p>{workflow.description}</p>
          <div className="execution-view-note">
            <Code2 size={17} />
            <p><strong>设计者视图：</strong>{isCodeStageWorkflow
              ? "展示 12 个真实代码阶段；其中只有 ModelCallApprovalExecutor 是 MAF 图节点。"
              : `展示 ${workflow.nodes.length} 个真实 MAF 节点和节点间经过的公开内容。`}</p>
          </div>
          <dl className="run-facts">
            <div><dt>Product Run</dt><dd className="mono">{latestRun?.id ?? "发送后创建"}</dd></div>
            <div><dt>AG-UI Run</dt><dd className="mono">{latestRun?.agui_run_id ?? "发送后创建"}</dd></div>
            <div><dt>模型路由</dt><dd>{provider?.label ?? latestRun?.model_provider_id ?? "审批时确认"}{model ? ` / ${model}` : ""}</dd></div>
            <div><dt>运行结构</dt><dd>{isCodeStageWorkflow ? "4 层 · 12 阶段 · 1 个 MAF Executor" : `${workflow.nodes.length} 个 MAF节点 · 模型调用和产品决策分别受治理`}</dd></div>
          </dl>
        </section>

        {traceError && <p className="execution-trace-error">实时Trace暂不可用，当前使用Product Run终态投影：{traceError}</p>}
        {isCodeStageWorkflow ? (
          <section className="execution-chain" aria-label="代码执行阶段">
            <header className="execution-chain-heading">
              <div><Route size={18} /><strong>本轮代码执行链</strong></div>
              <span>{trace.filter((event) => event.event_type === "workflow.stage").length} 条阶段事件</span>
            </header>
            {WORKFLOW_STAGE_GROUPS.map((group) => {
              const GroupIcon = GROUP_ICONS[group.id];
              const groupStages = projection.stages.filter((stage) => stage.group === group.id);
              return (
                <section className={`execution-group execution-group--${group.id}`} key={group.id}>
                  <header><span><GroupIcon size={17} /></span><div><strong>{group.label}</strong><p>{group.description}</p></div></header>
                  {group.id === "maf" && (
                    <div className="maf-executor-banner"><span>真实 MAF 图节点</span><strong>ModelCallApprovalExecutor</strong><code>executor_id: model_call_approval</code></div>
                  )}
                  <div className="execution-stage-list">
                    {groupStages.map((stage) => (
                      <StageRow
                        content={publicContentForStage(stage, prompt, assistantOutput, latestRun, modelReview)}
                        expanded={expandedStageId === stage.id}
                        key={stage.id}
                        number={projection.stages.findIndex((value) => value.id === stage.id) + 1}
                        onToggle={() => setExpandedStageId(expandedStageId === stage.id ? null : stage.id)}
                        stage={stage}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </section>
        ) : (
          <GenericWorkflowChain governance={governance} pendingReview={pendingReview} trace={trace} workflow={workflow} />
        )}

        <section className="run-content-card">
          <div className="workbench-section-heading"><div><ShieldCheck size={18} /><strong>本轮公开内容</strong></div><small>不展示隐藏推理</small></div>
          <div className="run-prompt-preview"><span>用户输入</span><p>{prompt || "发送消息后，这里会显示绑定到本轮 Workflow 的输入。"}</p></div>
          {pendingReview ? (
            <div className="approval-callout"><Clock3 size={19} /><div><strong>{pendingReview.review_kind === "product_decision" ? "产品决定正在等待处理" : "模型请求正在等待审批"}</strong><p>{pendingReview.review_kind === "product_decision" ? "当前Subject、有效策略和可修改字段已在人工介入界面打开。" : "完整可编辑请求已在审批界面打开；批准后才会发送给 Provider。"}</p></div></div>
          ) : (
            <p className="workbench-note">点击上方任一阶段或节点可查看它经过的公开内容。关闭工作台不会取消 Product Run。</p>
          )}
        </section>
      </div>
    </aside>
  );
}

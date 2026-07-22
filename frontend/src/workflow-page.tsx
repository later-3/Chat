import type { Message } from "@ag-ui/core";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Circle,
  GitBranch,
  Layers3,
  LoaderCircle,
  Play,
  RotateCcw,
  Workflow,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState, type CSSProperties } from "react";

import { ModelCallReview } from "./model-call-review";
import { ProductDecisionReview } from "./product-decision-review";
import { ToolCallReview } from "./tool-call-review";
import type { ProductSession } from "./session-api";
import {
  getLatestWorkflowTrace,
  type ProductTraceEvent,
  type WorkflowDefinition,
  type WorkflowNodeStatus,
} from "./workflow-api";
import type { WorkflowNodeProgress } from "./workflow-progress";
import { useWorkflowAgent } from "./use-workflow-agent";

interface WorkflowPageProps {
  definitions: WorkflowDefinition[];
  session: ProductSession | null;
  hydratedMessages: Message[];
  hydrationVersion: number;
  blocked: boolean;
  onSessionSettled: (hydrateMessages: boolean) => void;
  onRunningChange: (running: boolean) => void;
}

const STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  idle: "未开始",
  in_progress: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "已失败",
  abandoned: "已放弃",
  skipped: "已跳过",
};

const KIND_LABELS: Record<string, string> = {
  input: "输入",
  workflow: "子流程",
  transform: "转换",
  policy: "规则",
  decision: "决策",
  output: "输出",
  agent: "Agent",
  handoff: "会话交接",
  tool: "Tool",
  approval: "审批门",
};

const RUNTIME_LABELS: Record<string, string> = {
  workflow: "MAF Workflow",
  agent: "受治理 Agent",
  executor: "确定性 Executor",
  tool: "Tool",
  approval: "审批",
};

function StatusIcon({ status }: { status: WorkflowNodeStatus }) {
  if (status === "in_progress") return <LoaderCircle className="workflow-spin" size={15} />;
  if (status === "completed") return <Check size={15} />;
  if (status === "failed") return <AlertTriangle size={15} />;
  return <Circle size={13} />;
}

function detailMessage(progress: WorkflowNodeProgress): string | null {
  const message = progress.details?.message;
  return typeof message === "string" ? message : null;
}

export function WorkflowPage({
  definitions,
  session,
  hydratedMessages,
  hydrationVersion,
  blocked,
  onSessionSettled,
  onRunningChange,
}: WorkflowPageProps) {
  const [selectedId, setSelectedId] = useState(definitions[0]?.id ?? "");
  const [input, setInput] = useState("检查当前交付质量");
  const [restoredTrace, setRestoredTrace] = useState<ProductTraceEvent[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const definition = definitions.find((value) => value.id === selectedId) ?? definitions[0] ?? null;

  useEffect(() => {
    if (!selectedId && definitions[0]) setSelectedId(definitions[0].id);
  }, [definitions, selectedId]);

  useEffect(() => {
    if (!session || !definition) {
      setRestoredTrace([]);
      return;
    }
    let cancelled = false;
    setTraceLoading(true);
    void getLatestWorkflowTrace(session.id, definition.id)
      .then((trace) => {
        if (!cancelled) setRestoredTrace(trace);
      })
      .catch(() => {
        if (!cancelled) setRestoredTrace([]);
      })
      .finally(() => {
        if (!cancelled) setTraceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definition, session]);

  if (!definition) {
    return (
      <main className="workflow-layout">
        <div className="workflow-empty">当前没有已注册的Workflow。</div>
      </main>
    );
  }

  return (
    <WorkflowRuntime
      blocked={blocked}
      definition={definition}
      definitions={definitions}
      hydratedMessages={hydratedMessages}
      hydrationVersion={hydrationVersion}
      input={input}
      key={definition.id}
      onInputChange={setInput}
      onRunningChange={onRunningChange}
      onSelectDefinition={setSelectedId}
      onSessionSettled={onSessionSettled}
      restoredTrace={restoredTrace}
      selectedDefinitionId={definition.id}
      session={session}
      traceLoading={traceLoading}
    />
  );
}

interface WorkflowRuntimeProps {
  definition: WorkflowDefinition;
  definitions: WorkflowDefinition[];
  selectedDefinitionId: string;
  session: ProductSession | null;
  hydratedMessages: Message[];
  hydrationVersion: number;
  restoredTrace: ProductTraceEvent[];
  input: string;
  blocked: boolean;
  traceLoading: boolean;
  onInputChange: (value: string) => void;
  onSessionSettled: (hydrateMessages: boolean) => void;
  onRunningChange: (running: boolean) => void;
  onSelectDefinition: (id: string) => void;
}

function WorkflowRuntime({
  definition,
  definitions,
  selectedDefinitionId,
  session,
  hydratedMessages,
  hydrationVersion,
  restoredTrace,
  input,
  blocked,
  traceLoading,
  onInputChange,
  onSessionSettled,
  onRunningChange,
  onSelectDefinition,
}: WorkflowRuntimeProps) {
  const { status, error, progress, runId, pendingReview, run, approve, revise, abandon, decideProduct } = useWorkflowAgent({
    definition,
    sessionId: session?.id ?? null,
    hydratedMessages,
    hydrationVersion,
    restoredTrace,
    onSessionSettled,
    onRunningChange,
  });
  const summary = useMemo(() => {
    const values = Object.values(progress);
    return {
      completed: values.filter((value) => value.status === "completed").length,
      running: values.filter((value) => value.status === "in_progress").length,
      failed: values.filter((value) => value.status === "failed").length,
    };
  }, [progress]);
  const busy = status !== "idle" && status !== "succeeded" && status !== "failed";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input.trim() || busy || blocked || !session) return;
    void run(input);
  };

  return (
    <main className="workflow-layout">
      <header className="workflow-page-header">
        <div className="workflow-title-block">
          <span className="workflow-title-icon"><Workflow size={21} /></span>
          <div>
            <p className="eyebrow">MAF WORKFLOW · v{definition.version}</p>
            <h1>{definition.name}</h1>
            <p>{definition.description}</p>
          </div>
        </div>
        <div className="workflow-header-controls">
          <label className="workflow-selector">
            <span>选择Workflow</span>
            <select
              disabled={busy || definitions.length < 2}
              onChange={(event) => onSelectDefinition(event.target.value)}
              value={selectedDefinitionId}
            >
              {definitions.map((value) => (
                <option key={value.id} value={value.id}>{value.name} · v{value.version}</option>
              ))}
            </select>
          </label>
          <div className={`workflow-run-state workflow-run-state--${status}`}>
            {busy ? <LoaderCircle className="workflow-spin" size={14} /> : <Layers3 size={14} />}
            {status === "idle" && (restoredTrace.length ? "已恢复最近Trace" : "等待运行")}
            {status === "running" && "正在推进"}
            {status === "awaiting_approval" && "等待模型调用审批"}
            {status === "saving" && "保存请求修改"}
            {status === "succeeded" && "本次已完成"}
            {status === "failed" && "本次失败"}
          </div>
        </div>
      </header>

      <section className="workflow-dashboard">
        <div className="workflow-run-stage">
          <div className="workflow-section-heading">
            <div><span>执行图</span><strong>{definition.nodes.length} 个节点 · {definition.edges.length} 条连接</strong></div>
            <small>节点状态来自MAF → AG-UI事件</small>
          </div>
          <div className="workflow-node-list" aria-label="Workflow节点进度">
            {definition.nodes.map((node) => {
              const nodeProgress = progress[node.id];
              const message = detailMessage(nodeProgress);
              return (
                <article
                  className={`workflow-node workflow-node--${nodeProgress.status} workflow-node--depth-${node.depth}`}
                  key={node.id}
                  style={{ "--workflow-depth": node.depth } as CSSProperties}
                >
                  <div className="workflow-node-rail">
                    <span className="workflow-node-status"><StatusIcon status={nodeProgress.status} /></span>
                    {node.depth > 0 && <span className="workflow-node-parent"><ChevronRight size={13} /></span>}
                  </div>
                  <div className="workflow-node-copy">
                    <div>
                      <strong>{node.label}</strong>
                      <span>{KIND_LABELS[node.kind] ?? node.kind}</span>
                      <span>{RUNTIME_LABELS[node.runtime_type] ?? node.runtime_type}</span>
                    </div>
                    <p>{node.description}</p>
                    {message && <small>{message}</small>}
                  </div>
                  <span className="workflow-node-state-label">{STATUS_LABELS[nodeProgress.status]}</span>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="workflow-inspector">
          <div className="workflow-metrics">
            <div><span>{summary.completed}</span><small>已完成</small></div>
            <div><span>{summary.running}</span><small>运行中</small></div>
            <div><span>{summary.failed}</span><small>失败</small></div>
          </div>
          <div className="workflow-facts">
            <div><span>Product Session</span><code>{session?.id ?? "—"}</code></div>
            <div><span>AG-UI Run</span><code>{runId ?? "等待创建"}</code></div>
            <div><span>恢复投影</span><strong>{traceLoading ? "读取中" : `${restoredTrace.length} 条Trace`}</strong></div>
          </div>
          <div className="workflow-explainer">
            <GitBranch size={17} />
            <div><strong>节点不一定是Agent</strong><p>同一投影可显示普通Executor、嵌套Workflow和受治理Agent；Agent的每次真实模型调用仍单独审批。</p></div>
          </div>
        </aside>
      </section>

      <form className="workflow-launcher" onSubmit={submit}>
        <div className="workflow-scenario-buttons">
          <button disabled={busy} onClick={() => onInputChange("检查当前交付质量")} type="button"><Check size={14} />成功场景</button>
          <button disabled={busy} onClick={() => onInputChange("检查当前交付质量 [fail]")} type="button"><AlertTriangle size={14} />失败场景</button>
          <button disabled={busy} onClick={() => onInputChange("")} type="button"><RotateCcw size={14} />清空</button>
        </div>
        <div className="workflow-input-row">
          <label><span>本次Workflow输入</span><input disabled={busy || blocked || !session} onChange={(event) => onInputChange(event.target.value)} value={input} /></label>
          <button disabled={!input.trim() || busy || blocked || !session} onClick={() => void run(input)} type="button"><Play size={16} />{busy ? "运行中" : "运行Workflow"}</button>
        </div>
        {error && <p className="workflow-error" role="alert">{error}</p>}
      </form>
      {pendingReview && pendingReview.review_kind !== "tool_execution" && pendingReview.review_kind !== "product_decision" && (
        <ModelCallReview
          busy={status === "running" || status === "saving"}
          card={pendingReview}
          onAbandon={() => { void abandon().then((prompt) => { if (prompt !== null) onInputChange(prompt); }); }}
          onApprove={() => void approve()}
          onRevise={(providerId, providerRequest) => void revise(providerId, providerRequest)}
          requestError={error}
        />
      )}
      {pendingReview?.review_kind === "product_decision" && (
        <ProductDecisionReview
          busy={status === "running" || status === "saving"}
          card={pendingReview}
          key={pendingReview.approval_id}
          onDecision={(decision, changes) => void decideProduct(decision, changes)}
          requestError={error}
        />
      )}
      {pendingReview?.review_kind === "tool_execution" && (
        <ToolCallReview
          busy={status === "running" || status === "saving"}
          card={pendingReview}
          error={error}
          onAbandon={() => { void abandon().then((prompt) => { if (prompt !== null) onInputChange(prompt); }); }}
          onApprove={(argumentsValue) => void approve(argumentsValue)}
        />
      )}
    </main>
  );
}

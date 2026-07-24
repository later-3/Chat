import { Clock3, Code2, PanelRightClose, ShieldCheck, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  GenericWorkflowChain,
  governanceForNode,
  internalActivityForNode,
  outputForNode,
  stepInputForNode,
  WorkflowCodeStageChain,
} from "./features/workflow/workflow-run-details.js";
import { WorkflowSystemJourney } from "./features/workflow/workflow-system-journey.js";
import type { ProductRun } from "./session-api.js";
import type { GovernedReviewCard, ModelCallReviewCard, RunStatus } from "./use-chat-agent.js";
import { WorkbenchNav, type WorkbenchView } from "./workbench-nav.js";
import {
  type GovernedToolExecution,
  getRunGovernance,
  getRunStepInputs,
  getRunToolExecutions,
  getRunTrace,
  type ProductTraceEvent,
  type RunGovernanceView,
  type StepInputProjection,
  type WorkflowDefinition,
} from "./workflow-api.js";
import { CHAT_WORKFLOW, deriveWorkflowRunProjection } from "./workflow-run-projection.js";

interface WorkflowRunViewProps {
  workflow: WorkflowDefinition;
  latestRun: ProductRun | null;
  pendingReview: GovernedReviewCard | null;
  prompt: string | null;
  assistantOutput: string | null;
  runStatus: RunStatus;
  onClose: () => void;
  onViewChange: (view: WorkbenchView) => void;
  pendingDecisionCount?: number;
}

export { governanceForNode, internalActivityForNode, outputForNode, stepInputForNode };

export function WorkflowRunView({
  workflow,
  latestRun,
  pendingReview,
  prompt,
  assistantOutput,
  runStatus,
  onClose,
  onViewChange,
  pendingDecisionCount = 0,
}: WorkflowRunViewProps) {
  const [trace, setTrace] = useState<ProductTraceEvent[]>([]);
  const [governance, setGovernance] = useState<RunGovernanceView | null>(null);
  const [stepInputs, setStepInputs] = useState<StepInputProjection[]>([]);
  const [toolExecutions, setToolExecutions] = useState<GovernedToolExecution[]>([]);
  const [traceError, setTraceError] = useState<string | null>(null);
  const latestRunId = latestRun?.id ?? null;
  const latestSessionId = latestRun?.session_id ?? null;
  const latestRunStatus = latestRun?.status ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!latestRunId || !latestSessionId) {
      setTrace([]);
      setGovernance(null);
      setStepInputs([]);
      setToolExecutions([]);
      setTraceError(null);
      return undefined;
    }
    const load = () => {
      void getRunTrace(latestSessionId, latestRunId)
        .then((events) => {
          if (!cancelled) {
            setTrace(events);
            setTraceError(null);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setTraceError(error instanceof Error ? error.message : "Trace读取失败");
        });
      void getRunGovernance(latestRunId)
        .then((value) => {
          if (!cancelled) setGovernance(value);
        })
        .catch(() => {
          // Governance detail is optional for runs created before its schema.
          // Product Trace remains the authoritative execution projection.
          if (!cancelled) setGovernance(null);
        });
      void getRunStepInputs(latestRunId)
        .then((value) => {
          if (!cancelled) setStepInputs(value);
        })
        .catch(() => {
          // Runs created before StepInputProjection remain readable through
          // Product Trace without inventing a historical runtime work package.
          if (!cancelled) setStepInputs([]);
        });
      void getRunToolExecutions(latestRunId)
        .then((value) => {
          if (!cancelled) setToolExecutions(value);
        })
        .catch(() => {
          // Workflows without governed external tools legitimately have no
          // ToolExecution projection.
          if (!cancelled) setToolExecutions([]);
        });
    };
    load();
    const active =
      (latestRunStatus !== null &&
        ["running", "waiting_approval", "accepted", "committing"].includes(latestRunStatus)) ||
      runStatus === "running" ||
      runStatus === "saving" ||
      runStatus === "awaiting_approval";
    const timer = active ? window.setInterval(load, 700) : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [latestRunId, latestRunStatus, latestSessionId, runStatus]);

  const projection = useMemo(
    () => deriveWorkflowRunProjection(runStatus, Boolean(pendingReview), latestRun, trace),
    [latestRun, pendingReview, runStatus, trace],
  );
  const modelReview: ModelCallReviewCard | null =
    pendingReview &&
    pendingReview.review_kind !== "product_decision" &&
    pendingReview.review_kind !== "tool_execution"
      ? pendingReview
      : null;
  const provider = modelReview?.provider_catalog.find(
    (value) => value.id === modelReview.provider_id,
  );
  const model =
    typeof modelReview?.provider_request.model === "string"
      ? modelReview.provider_request.model
      : latestRun?.model;
  const isCodeStageWorkflow = workflow.id === CHAT_WORKFLOW.id;

  return (
    <aside className="workbench" aria-label="Workflow Run 工作台">
      <header className="workbench-header">
        <div>
          <p className="eyebrow">DESIGNER WORKBENCH</p>
          <strong>{isCodeStageWorkflow ? "代码执行链" : "Workflow 运行视图"}</strong>
        </div>
        <button aria-label="关闭工作台" onClick={onClose} type="button">
          <PanelRightClose size={20} />
          <span>返回对话</span>
        </button>
      </header>
      <WorkbenchNav active="workflow" onChange={onViewChange} pendingCount={pendingDecisionCount} />

      <div className="workbench-body">
        <section className="run-summary-card">
          <div className="run-summary-heading">
            <span className="run-summary-icon">
              <Workflow size={22} />
            </span>
            <div>
              <strong>{workflow.name}</strong>
              <small>Workflow Definition · v{workflow.version}</small>
            </div>
            <span className={`workflow-run-status workflow-run-status--${projection.status}`}>
              {projection.statusLabel}
            </span>
          </div>
          <p>{workflow.description}</p>
          <div className="execution-view-note">
            <Code2 size={17} />
            <p>
              <strong>设计者视图：</strong>
              {isCodeStageWorkflow
                ? "展示 12 个真实代码阶段；其中只有 ModelCallApprovalExecutor 是 MAF 图节点。"
                : `展示 ${workflow.nodes.length} 个真实 MAF 节点和节点间经过的公开内容。`}
            </p>
          </div>
          <dl className="run-facts">
            <div>
              <dt>Product Run</dt>
              <dd className="mono">{latestRun?.id ?? "发送后创建"}</dd>
            </div>
            <div>
              <dt>AG-UI Run</dt>
              <dd className="mono">{latestRun?.agui_run_id ?? "发送后创建"}</dd>
            </div>
            <div>
              <dt>Run Attempt</dt>
              <dd className="mono">
                {latestRun?.runtime_job?.run_attempt_id ??
                  latestRun?.attempts[0]?.id ??
                  "Worker领取后创建"}
              </dd>
            </div>
            <div>
              <dt>Runtime Job</dt>
              <dd className="mono">{latestRun?.runtime_job?.id ?? "排队后创建"}</dd>
            </div>
            <div>
              <dt>Worker / Lease</dt>
              <dd>
                {latestRun?.runtime_job?.lease_owner
                  ? `${latestRun.runtime_job.lease_owner} / epoch ${latestRun.runtime_job.lease_epoch}`
                  : "尚未持有Lease"}
              </dd>
            </div>
            <div>
              <dt>事件游标</dt>
              <dd>
                {latestRun?.runtime_job
                  ? `Sequence ${latestRun.runtime_job.last_event_sequence} · ${latestRun.runtime_job.recoverability}`
                  : "尚未产生"}
              </dd>
            </div>
            <div>
              <dt>模型路由</dt>
              <dd>
                {provider?.label ?? latestRun?.model_provider_id ?? "审批时确认"}
                {model ? ` / ${model}` : ""}
              </dd>
            </div>
            <div>
              <dt>运行结构</dt>
              <dd>
                {isCodeStageWorkflow
                  ? "4 层 · 12 阶段 · 1 个 MAF Executor"
                  : `${workflow.nodes.length} 个 MAF节点 · 模型调用和产品决策分别受治理`}
              </dd>
            </div>
          </dl>
        </section>

        {traceError && (
          <p className="execution-trace-error">
            实时Trace暂不可用，当前使用Product Run终态投影：{traceError}
          </p>
        )}
        {!isCodeStageWorkflow && (
          <WorkflowSystemJourney definition={workflow} run={latestRun} trace={trace} />
        )}
        {isCodeStageWorkflow ? (
          <WorkflowCodeStageChain
            assistantOutput={assistantOutput}
            latestRun={latestRun}
            modelReview={modelReview}
            projection={projection}
            prompt={prompt}
            trace={trace}
          />
        ) : (
          <GenericWorkflowChain
            governance={governance}
            pendingReview={pendingReview}
            stepInputs={stepInputs}
            toolExecutions={toolExecutions}
            trace={trace}
            workflow={workflow}
          />
        )}

        <section className="run-content-card">
          <div className="workbench-section-heading">
            <div>
              <ShieldCheck size={18} />
              <strong>本轮公开内容</strong>
            </div>
            <small>不展示隐藏推理</small>
          </div>
          <div className="run-prompt-preview">
            <span>用户输入</span>
            <p>{prompt || "发送消息后，这里会显示绑定到本轮 Workflow 的输入。"}</p>
          </div>
          {pendingReview ? (
            <div className="approval-callout">
              <Clock3 size={19} />
              <div>
                <strong>
                  {pendingReview.review_kind === "product_decision"
                    ? "产品决定正在等待处理"
                    : pendingReview.review_kind === "tool_execution"
                      ? pendingReview.tool_operation
                        ? "pi隔离工作区修改正在等待审批"
                        : "pi只读Tool调用正在等待审批"
                      : "模型请求正在等待审批"}
                </strong>
                <p>
                  {pendingReview.review_kind === "product_decision"
                    ? "当前Subject、有效策略和可修改字段已在人工介入界面打开。"
                    : pendingReview.review_kind === "tool_execution"
                      ? pendingReview.tool_operation
                        ? "精确文件、Diff和内容Hash已打开；批准后只在隔离工作区执行这一次修改。"
                        : "当前Tool名称、只读参数和Repository Snapshot围栏已打开；批准后只执行这一次调用。"
                      : "完整可编辑请求已在审批界面打开；批准后才会发送给 Provider。"}
                </p>
              </div>
            </div>
          ) : (
            <p className="workbench-note">
              点击上方任一阶段或节点可查看它经过的公开内容。关闭工作台不会取消 Product Run。
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}

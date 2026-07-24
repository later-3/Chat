import { ChevronDown, Code2, Database, Eye, Radio, Route, Workflow } from "lucide-react";
import { useState } from "react";
import {
  WORKFLOW_STAGE_GROUPS,
  type WorkflowRunProjection,
  type WorkflowStageGroup,
  type WorkflowStageProjection,
} from "../../workflow-run-projection.js";
import type { ModelCallReviewCard } from "../chat/chat-agent-contracts.js";
import type { ProductRun } from "../session/session-api.js";
import type { ProductTraceEvent } from "./workflow-api.js";
import {
  formatOccurredAt,
  NodeDetail,
  STAGE_STATUS_LABELS,
  type StageContent,
  StageIcon,
} from "./workflow-run-content.js";

const GROUP_ICONS: Record<WorkflowStageGroup, typeof Route> = {
  ingress: Route,
  maf: Workflow,
  provider: Radio,
  finalization: Database,
};

function publicContentForStage(
  stage: WorkflowStageProjection,
  prompt: string | null,
  assistantOutput: string | null,
  latestRun: ProductRun | null,
  pendingReview: ModelCallReviewCard | null,
): StageContent {
  const requestModel =
    typeof pendingReview?.provider_request.model === "string"
      ? pendingReview.provider_request.model
      : latestRun?.model;
  const draftFacts = pendingReview
    ? {
        draft_version: pendingReview.version,
        binding_hash: pendingReview.binding_hash,
        provider: pendingReview.provider_id,
        model: requestModel,
      }
    : {};
  const baseFacts = {
    status: STAGE_STATUS_LABELS[stage.status],
    layer: stage.layer,
    runtime_type: stage.runtimeType,
    occurred_at: formatOccurredAt(stage.occurredAt),
    ...stage.details,
  };
  switch (stage.id) {
    case "agui.ingress":
      return {
        input: prompt,
        output: { thread_id: latestRun?.session_id, agui_run_id: latestRun?.agui_run_id },
        facts: baseFacts,
      };
    case "product.prepare":
      return {
        input: prompt,
        output: { product_run_id: latestRun?.id, status: latestRun?.status },
        facts: baseFacts,
      };
    case "maf.enter":
      return { input: prompt, output: "进入 chat-model-call-approval Workflow", facts: baseFacts };
    case "request.compile":
      return { input: prompt, output: draftFacts, facts: baseFacts };
    case "approval.wait":
      return {
        input: draftFacts,
        output: pendingReview ? "等待你确认、修改或放弃" : STAGE_STATUS_LABELS[stage.status],
        facts: baseFacts,
      };
    case "approval.claim":
      return {
        input: draftFacts,
        output: stage.status === "completed" ? "已锁定唯一审批版本" : null,
        facts: baseFacts,
      };
    case "provider.dispatch":
      return {
        input: pendingReview ? "尚未发送；完整请求在审批界面中" : draftFacts,
        output: stage.status === "completed" ? "请求已到达 Provider" : null,
        facts: baseFacts,
      };
    case "provider.receive":
      return { input: "Provider 响应流", output: assistantOutput, facts: baseFacts };
    case "provider.decode":
      return { input: "Provider SSE / JSON 响应", output: assistantOutput, facts: baseFacts };
    case "agui.project":
      return { input: assistantOutput, output: "AG-UI 文本事件已投影到聊天区", facts: baseFacts };
    case "product.commit":
      return {
        input: assistantOutput,
        output: { assistant_message: assistantOutput, run_status: latestRun?.status },
        facts: baseFacts,
      };
    case "agui.terminal":
      return {
        input: latestRun?.status,
        output: `AG-UI Run ${latestRun?.status ?? "尚未结束"}`,
        facts: baseFacts,
      };
  }
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
    <article
      className={`execution-stage execution-stage--${stage.status} ${expanded ? "execution-stage--expanded" : ""}`}
    >
      <button
        aria-expanded={expanded}
        className="execution-stage-toggle"
        onClick={onToggle}
        type="button"
      >
        <span className="execution-stage-rail" aria-hidden="true">
          <span className="execution-stage-number">{String(number).padStart(2, "0")}</span>
          <span className="execution-stage-icon">
            <StageIcon status={stage.status} />
          </span>
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
          <span className="execution-stage-source">
            <Code2 size={14} />
            <code>{stage.source}</code>
          </span>
        </span>
        <span className="execution-stage-expand">
          <Eye size={15} />
          查看内容
          <ChevronDown size={15} />
        </span>
      </button>
      {expanded && <NodeDetail {...content} />}
    </article>
  );
}

export function WorkflowCodeStageChain({
  projection,
  trace,
  prompt,
  assistantOutput,
  latestRun,
  modelReview,
}: {
  projection: WorkflowRunProjection;
  trace: ProductTraceEvent[];
  prompt: string | null;
  assistantOutput: string | null;
  latestRun: ProductRun | null;
  modelReview: ModelCallReviewCard | null;
}) {
  const [expandedStageId, setExpandedStageId] = useState<string | null>(null);
  return (
    <section className="execution-chain" aria-label="代码执行阶段">
      <header className="execution-chain-heading">
        <div>
          <Route size={18} />
          <strong>本轮代码执行链</strong>
        </div>
        <span>
          {trace.filter((event) => event.event_type === "workflow.stage").length} 条阶段事件
        </span>
      </header>
      {WORKFLOW_STAGE_GROUPS.map((group) => {
        const GroupIcon = GROUP_ICONS[group.id];
        const groupStages = projection.stages.filter((stage) => stage.group === group.id);
        return (
          <section className={`execution-group execution-group--${group.id}`} key={group.id}>
            <header>
              <span>
                <GroupIcon size={17} />
              </span>
              <div>
                <strong>{group.label}</strong>
                <p>{group.description}</p>
              </div>
            </header>
            {group.id === "maf" && (
              <div className="maf-executor-banner">
                <span>真实 MAF 图节点</span>
                <strong>ModelCallApprovalExecutor</strong>
                <code>executor_id: model_call_approval</code>
              </div>
            )}
            <div className="execution-stage-list">
              {groupStages.map((stage) => (
                <StageRow
                  content={publicContentForStage(
                    stage,
                    prompt,
                    assistantOutput,
                    latestRun,
                    modelReview,
                  )}
                  expanded={expandedStageId === stage.id}
                  key={stage.id}
                  number={projection.stages.findIndex((value) => value.id === stage.id) + 1}
                  onToggle={() =>
                    setExpandedStageId(expandedStageId === stage.id ? null : stage.id)
                  }
                  stage={stage}
                />
              ))}
            </div>
          </section>
        );
      })}
    </section>
  );
}

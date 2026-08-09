import type { WorkflowNodeRunSummaryDto } from "@chat/contracts/public";

type WorkflowNodeRunStatus = WorkflowNodeRunSummaryDto["status"];

export const WORKFLOW_STATUS: Record<
  WorkflowNodeRunStatus,
  {
    readonly label: string;
    readonly symbol: string;
    readonly tone: "neutral" | "success" | "warning" | "danger";
  }
> = {
  queued: { label: "排队中", symbol: "○", tone: "neutral" },
  running: { label: "运行中", symbol: "▶", tone: "warning" },
  waiting_human: { label: "等待人工审核", symbol: "◆", tone: "warning" },
  succeeded: { label: "已完成", symbol: "✓", tone: "success" },
  failed: { label: "失败", symbol: "!", tone: "danger" },
  skipped: { label: "已跳过", symbol: "–", tone: "neutral" },
  cancelled: { label: "已取消", symbol: "×", tone: "danger" },
  outcome_unknown: { label: "结果待确认", symbol: "?", tone: "danger" },
};

const NODE_TYPE_LABELS: Readonly<Record<string, string>> = {
  "context.compile": "上下文",
  "agent.plan": "Agent规划",
  "human.plan_review": "人工审核",
  "execute.plan": "计划执行",
  "execute.plan_step": "执行步骤",
  "result.validate": "结果验证",
  "product.commit": "产品提交",
};

export function workflowNodeTypeLabel(nodeType: string): string {
  return NODE_TYPE_LABELS[nodeType] ?? nodeType;
}

export function formatWorkflowDuration(nodeRun: WorkflowNodeRunSummaryDto): string | null {
  if (nodeRun.durationMs === undefined) return null;
  if (nodeRun.durationMs < 1_000) return `${String(nodeRun.durationMs)} ms`;
  if (nodeRun.durationMs < 60_000) return `${(nodeRun.durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(nodeRun.durationMs / 60_000)}m ${Math.round(
    (nodeRun.durationMs % 60_000) / 1_000,
  )}s`;
}

import type { ProductRun } from "./session-api.js";
import type { RunStatus } from "./use-chat-agent.js";
import type { ProductTraceEvent } from "./workflow-api.js";
import type { WorkflowDefinition } from "./workflow-api.js";

export const CHAT_WORKFLOW = {
  id: "chat-model-call-approval",
  name: "发送前可编辑 Prompt",
  version: "1.0.0",
  description: "准备真实模型请求，等待用户逐次审批，再发送给 Provider 并提交结果。",
  endpoint: "/api/agent",
  selectable: true,
  nodes: [{
    id: "model_call_approval",
    label: "审批并发送模型请求",
    description: "编译可编辑请求、等待审批、准确发送并提交模型结果。",
    kind: "approval",
    runtime_type: "executor",
    parent_id: null,
    depth: 0,
  }],
  edges: [],
} as const satisfies WorkflowDefinition;

export type WorkflowStageStatus =
  | "not_started"
  | "in_progress"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "abandoned"
  | "skipped";

export type WorkflowStageGroup = "ingress" | "maf" | "provider" | "finalization";

export interface WorkflowStageDefinition {
  id:
    | "agui.ingress"
    | "product.prepare"
    | "maf.enter"
    | "request.compile"
    | "approval.wait"
    | "approval.claim"
    | "provider.dispatch"
    | "provider.receive"
    | "provider.decode"
    | "agui.project"
    | "product.commit"
    | "agui.terminal";
  label: string;
  description: string;
  group: WorkflowStageGroup;
  layer: string;
  runtimeType: string;
  source: string;
  mafExecutorChild?: boolean;
}

export interface WorkflowStageProjection extends WorkflowStageDefinition {
  status: WorkflowStageStatus;
  details: Record<string, unknown> | null;
  occurredAt: string | null;
}

export interface WorkflowRunProjection {
  status: "not_started" | "running" | "waiting_approval" | "completed" | "failed" | "abandoned";
  statusLabel: string;
  stages: WorkflowStageProjection[];
}

export const WORKFLOW_STAGE_GROUPS: Array<{
  id: WorkflowStageGroup;
  label: string;
  description: string;
}> = [
  { id: "ingress", label: "01 · 请求接纳与产品事实", description: "AG-UI 入站和 Product Run 创建边界" },
  { id: "maf", label: "02 · MAF Workflow", description: "唯一真实 Executor 及其内部代码阶段" },
  { id: "provider", label: "03 · Provider Transport", description: "准确发送已审批 Bytes，并接收、解码响应" },
  { id: "finalization", label: "04 · 输出投影与产品提交", description: "AG-UI 文本事件、Product Message 和最终运行状态" },
];

export const WORKFLOW_STAGES: WorkflowStageDefinition[] = [
  {
    id: "agui.ingress",
    label: "接收 AG-UI Run 请求",
    description: "接收 threadId、runId、消息和恢复控制，进入本次服务端执行。",
    group: "ingress",
    layer: "Web / AG-UI",
    runtimeType: "Protocol boundary",
    source: "model_call_workflow.py · RunTrackingWorkflow.run",
  },
  {
    id: "product.prepare",
    label: "准备 Product Run",
    description: "校验产品历史，创建或恢复 Interaction、Run、Attempt 与 User Message。",
    group: "ingress",
    layer: "Product application",
    runtimeType: "Finality gate",
    source: "product_sessions/service.py · prepare_agui_run",
  },
  {
    id: "maf.enter",
    label: "进入 MAF Workflow",
    description: "运行 chat-model-call-approval 图；当前图中只有 1 个真实 Executor。",
    group: "maf",
    layer: "MAF runtime",
    runtimeType: "Workflow boundary",
    source: "model_call_workflow.py · create_model_call_workflow",
  },
  {
    id: "request.compile",
    label: "编译模型请求草稿",
    description: "归一化消息，选择 Provider/模型，并生成可审核 Body、版本和 Hash。",
    group: "maf",
    layer: "MAF Executor",
    runtimeType: "Deterministic code stage",
    source: "ModelCallApprovalExecutor.prepare",
    mafExecutorChild: true,
  },
  {
    id: "approval.wait",
    label: "等待发送前审批",
    description: "通过 MAF RequestInfo 暂停；修改会生成新版草稿，放弃则零发送。",
    group: "maf",
    layer: "MAF Executor",
    runtimeType: "HITL interrupt",
    source: "ModelCallApprovalExecutor.prepare / resolve",
    mafExecutorChild: true,
  },
  {
    id: "approval.claim",
    label: "锁定已审批版本",
    description: "按 Approval ID 与 Binding Hash 唯一领取，阻止旧版本或重复发送。",
    group: "maf",
    layer: "MAF Executor",
    runtimeType: "Concurrency gate",
    source: "ModelCallApprovalExecutor.resolve",
    mafExecutorChild: true,
  },
  {
    id: "provider.dispatch",
    label: "发送准确 Provider 请求",
    description: "通过目标 Provider 路由执行 HTTP POST，Body 使用审批绑定的准确 Bytes。",
    group: "provider",
    layer: "Provider adapter",
    runtimeType: "External I/O",
    source: "model_call_review.py · ExactProviderTransport.stream",
  },
  {
    id: "provider.receive",
    label: "等待并接收模型输出",
    description: "等待响应头和响应体，持续读取 SSE 数据或一次性读取 JSON。",
    group: "provider",
    layer: "Provider adapter",
    runtimeType: "Streaming I/O",
    source: "model_call_review.py · ExactProviderTransport.stream",
  },
  {
    id: "provider.decode",
    label: "解析 Provider 响应",
    description: "解码 SSE/JSON，并兼容 Responses 与 Chat Completions 的文本结构。",
    group: "provider",
    layer: "Provider adapter",
    runtimeType: "Protocol decoder",
    source: "model_call_review.py · _provider_text",
  },
  {
    id: "agui.project",
    label: "投影 AG-UI 文本事件",
    description: "把已解析文本逐段输出，前端可在模型仍生成时实时渲染。",
    group: "finalization",
    layer: "AG-UI projection",
    runtimeType: "Event stream",
    source: "ModelCallApprovalExecutor.resolve · ctx.yield_output",
  },
  {
    id: "product.commit",
    label: "提交 Product Session 结果",
    description: "写入 Assistant Message，并提交 Run、Attempt、Interaction 与 Session Revision。",
    group: "finalization",
    layer: "Product application",
    runtimeType: "Product finalization gate",
    source: "product_sessions/service.py · complete_active_run",
  },
  {
    id: "agui.terminal",
    label: "发送本次 AG-UI 终态",
    description: "仅在产品提交成功、明确失败或人工中断已经确定后发送终态事件。",
    group: "finalization",
    layer: "Web / AG-UI",
    runtimeType: "Protocol terminal",
    source: "model_call_workflow.py · RunTrackingWorkflow.run",
  },
];

function blankStages(): WorkflowStageProjection[] {
  return WORKFLOW_STAGES.map((stage) => ({
    ...stage,
    status: "not_started",
    details: null,
    occurredAt: null,
  }));
}

function setStatuses(
  stages: WorkflowStageProjection[],
  statuses: Partial<Record<WorkflowStageDefinition["id"], WorkflowStageStatus>>,
): WorkflowStageProjection[] {
  return stages.map((stage) => ({ ...stage, status: statuses[stage.id] ?? stage.status }));
}

function fallbackStages(
  runStatus: RunStatus,
  pendingApproval: boolean,
  latestRun: ProductRun | null,
): WorkflowStageProjection[] {
  let stages = blankStages();
  if (pendingApproval || runStatus === "awaiting_approval" || latestRun?.status === "waiting_approval") {
    return setStatuses(stages, {
      "agui.ingress": "completed",
      "product.prepare": "completed",
      "maf.enter": "in_progress",
      "request.compile": "completed",
      "approval.wait": "waiting_approval",
    });
  }
  if (latestRun?.status === "succeeded") {
    return stages.map((stage) => ({ ...stage, status: "completed" }));
  }
  if (latestRun?.status === "abandoned") {
    stages = setStatuses(stages, {
      "agui.ingress": "completed",
      "product.prepare": "completed",
      "maf.enter": "completed",
      "request.compile": "completed",
      "approval.wait": "abandoned",
      "approval.claim": "skipped",
      "provider.dispatch": "skipped",
      "provider.receive": "skipped",
      "provider.decode": "skipped",
      "agui.project": "skipped",
      "product.commit": "skipped",
      "agui.terminal": "completed",
    });
    return stages;
  }
  if (latestRun && ["failed", "cancelled", "interrupted", "outcome_unknown"].includes(latestRun.status)) {
    const commitFailed = latestRun.failure_code === "product_commit_failed";
    return setStatuses(stages, {
      "agui.ingress": "completed",
      "product.prepare": "completed",
      "maf.enter": "failed",
      "request.compile": "completed",
      "approval.wait": latestRun.status === "interrupted" ? "failed" : "completed",
      "approval.claim": latestRun.status === "interrupted" ? "skipped" : "completed",
      "provider.dispatch": commitFailed ? "completed" : "failed",
      "provider.receive": commitFailed ? "completed" : "skipped",
      "provider.decode": commitFailed ? "completed" : "skipped",
      "agui.project": commitFailed ? "completed" : "skipped",
      "product.commit": commitFailed ? "failed" : "skipped",
      "agui.terminal": "completed",
    });
  }
  if (runStatus === "running" || runStatus === "saving") {
    const providerStarted = latestRun?.status === "running" || latestRun?.status === "waiting_approval";
    return setStatuses(stages, {
      "agui.ingress": "completed",
      "product.prepare": "completed",
      "maf.enter": "in_progress",
      "request.compile": providerStarted ? "completed" : "in_progress",
      "approval.wait": providerStarted ? "completed" : "not_started",
      "approval.claim": providerStarted ? "completed" : "not_started",
      "provider.dispatch": providerStarted ? "in_progress" : "not_started",
    });
  }
  if (runStatus === "error") {
    return setStatuses(stages, {
      "agui.ingress": "completed",
      "product.prepare": "failed",
      "agui.terminal": "completed",
    });
  }
  return stages;
}

function applyTrace(
  stages: WorkflowStageProjection[],
  trace: ProductTraceEvent[],
): WorkflowStageProjection[] {
  const latestByStage = new Map<string, ProductTraceEvent>();
  for (const event of trace) {
    if (event.event_type !== "workflow.stage") continue;
    const stageId = event.payload.stage_id;
    const status = event.payload.status;
    if (typeof stageId !== "string" || typeof status !== "string") continue;
    if (!WORKFLOW_STAGES.some((stage) => stage.id === stageId)) continue;
    latestByStage.set(stageId, event);
  }
  return stages.map((stage) => {
    const event = latestByStage.get(stage.id);
    if (!event) return stage;
    const status = String(event.payload.status);
    if (!["not_started", "in_progress", "waiting_approval", "completed", "failed", "abandoned", "skipped"].includes(status)) {
      return stage;
    }
    const details = event.payload.details;
    return {
      ...stage,
      status: status as WorkflowStageStatus,
      details: details && typeof details === "object" ? details as Record<string, unknown> : null,
      occurredAt: event.created_at,
    };
  });
}

export function deriveWorkflowRunProjection(
  runStatus: RunStatus,
  pendingApproval: boolean,
  latestRun: ProductRun | null,
  trace: ProductTraceEvent[] = [],
): WorkflowRunProjection {
  let status: WorkflowRunProjection["status"] = "not_started";
  let statusLabel = "未开始";
  if (pendingApproval || runStatus === "awaiting_approval" || (runStatus === "idle" && latestRun?.status === "waiting_approval")) {
    status = "waiting_approval";
    statusLabel = "等待模型请求审批";
  } else if (runStatus === "running" || runStatus === "saving") {
    status = "running";
    statusLabel = latestRun?.status === "running" ? "正在调用模型" : "正在准备模型请求";
  } else if (latestRun?.status === "succeeded") {
    status = "completed";
    statusLabel = "已完成";
  } else if (latestRun?.status === "abandoned") {
    status = "abandoned";
    statusLabel = "已放弃";
  } else if (latestRun && ["failed", "cancelled", "interrupted", "outcome_unknown"].includes(latestRun.status)) {
    status = "failed";
    statusLabel = latestRun.status === "outcome_unknown" ? "结果未知，需要确认" : "运行未完成";
  } else if (runStatus === "error") {
    status = "failed";
    statusLabel = "运行未完成";
  }
  return {
    status,
    statusLabel,
    stages: applyTrace(fallbackStages(runStatus, pendingApproval, latestRun), trace),
  };
}

import type {
  ExecutionStepTraceDto,
  WorkflowExecutionTraceDto,
  WorkflowExecutionTraceValueDto,
  PiTraceActivityV2Dto as PiTraceActivityDto,
} from "@chat/contracts/public";
import type { LifeosExecutionTrace } from "../contracts.ts";
import type {
  ConversationNodeContext,
  ConversationNodeDefinition,
  ToolCallBlock,
} from "@deepseek-ai/dsh-client-runtime/client";

type PublicStatus =
  | WorkflowExecutionTraceDto["run"]["status"]
  | WorkflowExecutionTraceDto["workflow"]["nodeRuns"][number]["status"]
  | PiTraceActivityDto["status"]
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "waiting"
  | "received"
  | "disposed"
  | "sleeping";

interface BlockInput {
  readonly callId: string;
  readonly name: string;
  readonly status: PublicStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly details: Record<string, unknown>;
  readonly summary?: string;
  readonly output?: string;
  readonly subCalls?: readonly ToolCallBlock[];
  readonly seq: number;
}

export interface ExecutionTraceViewOptions {
  /** 在每一行结果摘要中显示浏览器本地时间范围；默认保持紧凑。 */
  readonly showTimestamps?: boolean;
}

export type ExecutionTraceForMessage = (dshMessageId: string) => LifeosExecutionTrace | undefined;

interface ExecutionTracePlacementState {
  readonly value?: LifeosExecutionTrace;
}

const EXECUTION_TRACE_BINDING_KIND = "lifeos-execution-trace-binding";

const STATUS_LABEL: Record<string, string> = {
  pending: "等待中",
  queued: "已排队",
  running: "运行中",
  waiting_human: "等待审核",
  retrying: "正在重试",
  waiting: "等待中",
  received: "已接收",
  sleeping: "休眠中",
  succeeded: "成功",
  completed: "完成",
  skipped: "已跳过",
  disposed: "已结束",
  failed: "失败",
  cancelled: "已取消",
  outcome_unknown: "结果未知",
  blocked: "已阻止",
};

const AGENT_ROLE_LABEL: Record<PiTraceActivityDto["nodeKind"], string> = {
  planner: "规划",
  executor: "执行",
  governance_reviewer: "工程治理检查",
  direct_agent: "直接执行",
  note_capture: "笔记",
};

function instant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRunning(status: PublicStatus): boolean {
  return [
    "pending",
    "queued",
    "running",
    "waiting_human",
    "retrying",
    "waiting",
    "received",
    "sleeping",
  ].includes(status);
}

function isError(status: PublicStatus): boolean {
  return ["failed", "cancelled", "blocked", "outcome_unknown"].includes(status);
}

function statusLabel(status: PublicStatus): string {
  return STATUS_LABEL[status] ?? status;
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${String(durationMs)}ms`;
  const seconds = durationMs / 1_000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

function formatTokens(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

function joinedSummary(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

function terminalSummary(status: PublicStatus, durationMs?: number, errorCode?: string): string {
  return joinedSummary([statusLabel(status), errorCode, formatDuration(durationMs)]);
}

function parsedTraceValue(value: WorkflowExecutionTraceValueDto): unknown {
  if (value.format !== "json") return value.text;
  try {
    return JSON.parse(value.text) as unknown;
  } catch {
    return value.text;
  }
}

function factPayload(values: readonly WorkflowExecutionTraceValueDto[]): readonly unknown[] {
  return values.map((value) => ({
    label: value.label,
    format: value.format,
    value: parsedTraceValue(value),
    truncated: value.truncated,
    ...(value.source === undefined ? {} : { source: value.source }),
  }));
}

function factOutput(
  summary: string,
  values: readonly WorkflowExecutionTraceValueDto[],
): string | undefined {
  if (values.length === 0) return undefined;
  return [summary, ...values.flatMap((value) => ["", `### ${value.label}`, value.text])].join("\n");
}

interface ActivityFactScope {
  readonly input: readonly WorkflowExecutionTraceValueDto[];
  readonly output: readonly WorkflowExecutionTraceValueDto[];
}

function block(input: BlockInput): ToolCallBlock {
  const startedAt = instant(input.startedAt);
  const subCalls = input.subCalls ?? [];
  const argsRaw = JSON.stringify(input.details);
  if (isRunning(input.status)) {
    return {
      callId: input.callId,
      name: input.name,
      argsRaw,
      turn: 0,
      step: 0,
      time: startedAt,
      callView: null,
      subCalls,
    };
  }
  const errored = isError(input.status);
  const summary = input.summary?.trim() || statusLabel(input.status);
  return {
    kind: "tool-result",
    seq: input.seq,
    time: instant(input.completedAt ?? input.startedAt),
    callId: input.callId,
    call: { name: input.name, argsRaw },
    callTime: startedAt,
    content: [{ type: "text", text: input.output?.trim() || summary }],
    isError: errored,
    ...(errored ? { error: { name: "ExecutionFailed", code: input.status } } : {}),
    callView: null,
    resultView: null,
    subCalls,
  };
}

function callStart(value: ToolCallBlock): number {
  return "kind" in value ? (value.callTime ?? value.time) : value.time;
}

function ordered(values: readonly ToolCallBlock[]): ToolCallBlock[] {
  return [...values].sort((left, right) => callStart(left) - callStart(right));
}

const TREE_NBSP = "\u00a0";

function treePrefix(ancestorLast: readonly boolean[], last: boolean): string {
  const rails = ancestorLast
    .map((ancestorWasLast) => (ancestorWasLast ? TREE_NBSP.repeat(3) : `│${TREE_NBSP.repeat(2)}`))
    .join("");
  return `${rails}${last ? "└─" : "├─"}${TREE_NBSP}`;
}

function localDateTime(value: number): string {
  const date = new Date(value);
  const pad = (part: number, length = 2): string => String(part).padStart(length, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function localTime(value: number): string {
  const date = new Date(value);
  const pad = (part: number, length = 2): string => String(part).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function localTimeRange(startedAt: number, completedAt?: number): string {
  if (completedAt === undefined) return `[${localDateTime(startedAt)} → 进行中]`;
  const start = new Date(startedAt);
  const end = new Date(completedAt);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  return `[${localDateTime(startedAt)} → ${sameDay ? localTime(completedAt) : localDateTime(completedAt)}]`;
}

/**
 * DSH rc.6会递归读取subCalls，但原生Ledger把所有深度统一画成SUBTOOL。
 * 插件只改自己贡献的Tool名称，使用树线保留可见深度；不查询或修改DSH DOM。
 */
function decorateTreeBlock(
  value: ToolCallBlock,
  ancestorLast: readonly boolean[],
  last: boolean,
  showTimestamps: boolean,
  root = false,
): ToolCallBlock {
  const childAncestors = root ? ancestorLast : [...ancestorLast, last];
  const children = value.subCalls.map((child, index, siblings) =>
    decorateTreeBlock(child, childAncestors, index === siblings.length - 1, showTimestamps),
  );
  const prefix = root ? "" : treePrefix(ancestorLast, last);
  if (!("kind" in value)) {
    return {
      ...value,
      name: `${prefix}${value.name}${showTimestamps ? ` · ${localTimeRange(value.time)}` : ""}`,
      subCalls: children,
    };
  }
  const startedAt = value.callTime ?? value.time;
  const range = localTimeRange(startedAt, value.time);
  const content = showTimestamps
    ? value.content.length > 0 && value.content[0]?.type === "text"
      ? [
          { ...value.content[0], text: `${range} ${value.content[0].text}` },
          ...value.content.slice(1),
        ]
      : [{ type: "text" as const, text: range }, ...value.content]
    : value.content;
  return {
    ...value,
    call: value.call === null ? null : { ...value.call, name: `${prefix}${value.call.name}` },
    content,
    subCalls: children,
  };
}

function activityName(activity: PiTraceActivityDto): string {
  const role = `${AGENT_ROLE_LABEL[activity.nodeKind]} Agent`;
  if (activity.kind === "model") {
    const model =
      activity.provider !== undefined && activity.model !== undefined
        ? `${activity.provider}/${activity.model}`
        : (activity.model ?? activity.provider ?? "未知模型");
    return `${role} · 模型：${model}`;
  }
  if (activity.kind === "tool") return `${role} · 工具：${activity.toolName ?? "未知工具"}`;
  return role;
}

function activitySummary(
  activity: PiTraceActivityDto,
  children: readonly PiTraceActivityDto[],
): string {
  if (activity.kind === "model" && activity.tokenUsage !== undefined) {
    return joinedSummary([
      statusLabel(activity.status),
      `${formatTokens(activity.tokenUsage.totalTokens)}（输入 ${activity.tokenUsage.promptTokens.toLocaleString("en-US")} / 输出 ${activity.tokenUsage.completionTokens.toLocaleString("en-US")}）`,
      activity.errorCode,
      formatDuration(activity.durationMs),
    ]);
  }
  if (activity.kind === "agent") {
    const modelCount = children.filter((child) => child.kind === "model").length;
    const toolCount = children.filter((child) => child.kind === "tool").length;
    const totalTokens = children.reduce(
      (sum, child) => sum + (child.tokenUsage?.totalTokens ?? 0),
      activity.tokenUsage?.totalTokens ?? 0,
    );
    return joinedSummary([
      statusLabel(activity.status),
      `${String(modelCount)} 次模型`,
      `${String(toolCount)} 次工具`,
      totalTokens > 0 ? formatTokens(totalTokens) : undefined,
      activity.errorCode,
      formatDuration(activity.durationMs),
    ]);
  }
  return terminalSummary(activity.status, activity.durationMs, activity.errorCode);
}

function activityBlock(
  activity: PiTraceActivityDto,
  children: readonly PiTraceActivityDto[],
  seq: number,
  facts: ActivityFactScope,
): ToolCallBlock {
  const visibleInput = facts.input;
  const details: Record<string, unknown> = {
    kind: activity.kind,
    status: activity.status,
    attemptId: activity.attemptId,
    startedAt: activity.startedAt,
    inputNotice: "以下为Chat已保存的输入事实，不是Provider原始Payload。",
    inputFacts: factPayload(visibleInput),
  };
  if (activity.workflowNodeRunId !== undefined)
    details.workflowNodeRunId = activity.workflowNodeRunId;
  if (activity.executionStepId !== undefined) details.executionStepId = activity.executionStepId;
  if (activity.completedAt !== undefined) details.completedAt = activity.completedAt;
  if (activity.provider !== undefined) details.provider = activity.provider;
  if (activity.model !== undefined) details.model = activity.model;
  if (activity.toolName !== undefined) details.tool = activity.toolName;
  if (activity.inputDisplay !== undefined) details.input = activity.inputDisplay;
  if (activity.inputDisplayTruncated !== undefined)
    details.inputTruncated = activity.inputDisplayTruncated;
  if (activity.resultDisplay !== undefined) details.result = activity.resultDisplay;
  if (activity.resultDisplayTruncated !== undefined)
    details.resultTruncated = activity.resultDisplayTruncated;
  if (activity.tokenUsage !== undefined) {
    details.promptTokens = activity.tokenUsage.promptTokens;
    details.completionTokens = activity.tokenUsage.completionTokens;
    details.totalTokens = activity.tokenUsage.totalTokens;
  }
  if (activity.durationMs !== undefined) details.durationMs = activity.durationMs;
  if (activity.errorCode !== undefined) details.errorCode = activity.errorCode;
  const summary = activitySummary(activity, children);
  const output =
    activity.kind === "tool"
      ? activity.resultDisplay
      : activity.kind === "agent"
        ? factOutput(summary, facts.output)
        : undefined;
  return block({
    callId: `lifeos-${activity.activityKey}`,
    name: activityName(activity),
    status: activity.status,
    startedAt: activity.startedAt,
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
    details,
    summary,
    ...(output === undefined ? {} : { output }),
    subCalls: ordered(children.map((child) => activityBlock(child, [], seq, facts))),
    seq,
  });
}

function reviewDecisionLabel(
  nodeType: string,
  outcomeCode: string | undefined,
): string | undefined {
  if (!nodeType.startsWith("human.") || outcomeCode === undefined) return undefined;
  const labels: Record<string, string> = {
    approve: "批准",
    approved: "批准",
    request_revision: "要求修订",
    reject: "拒绝",
    rejected: "拒绝",
  };
  return labels[outcomeCode] ?? outcomeCode;
}

function runtimeSpansForNode(
  trace: WorkflowExecutionTraceDto,
  nodeType: string,
): readonly unknown[] {
  if (trace.runtime.availability !== "available") return [];
  const belongs = (name: string, kind: string): boolean => {
    if (nodeType === "agent.plan") return /Plan|PlanningInput/u.test(name);
    if (nodeType === "human.plan_review")
      return kind === "hook" || kind === "sleep" || /Decision|Approval/u.test(name);
    if (nodeType === "execute.plan") return /Execut|ApprovedPlan|RunAttempt/u.test(name);
    if (nodeType === "result.validate") return /Validat/u.test(name);
    if (nodeType === "product.commit") return /CommitExecutionResult/u.test(name);
    return false;
  };
  return trace.runtime.spans
    .filter((span) => span.kind !== "run" && belongs(span.name, span.kind))
    .map((span) => ({
      kind: span.kind,
      name: span.name,
      status: span.status,
      createdAt: span.createdAt,
      startedAt: span.startedAt ?? null,
      completedAt: span.completedAt ?? null,
      durationMs: span.durationMs,
    }));
}

function rootRuntimeSpans(trace: WorkflowExecutionTraceDto): readonly unknown[] {
  if (trace.runtime.availability !== "available") return [];
  return trace.runtime.spans
    .filter((span) => span.kind !== "run" && /Load.*RunSpec/u.test(span.name))
    .map((span) => ({
      kind: span.kind,
      name: span.name,
      status: span.status,
      createdAt: span.createdAt,
      startedAt: span.startedAt ?? null,
      completedAt: span.completedAt ?? null,
      durationMs: span.durationMs,
    }));
}

function scopedAgentBlocks(
  trace: WorkflowExecutionTraceDto,
  seq: number,
  facts: ActivityFactScope,
  predicate: (activity: PiTraceActivityDto) => boolean,
): ToolCallBlock[] {
  return trace.piActivities
    .filter((activity) => activity.kind === "agent" && predicate(activity))
    .map((agent) =>
      activityBlock(
        agent,
        trace.piActivities.filter((activity) => activity.parentActivityKey === agent.activityKey),
        seq,
        facts,
      ),
    );
}

function executionStepCallId(step: ExecutionStepTraceDto): string {
  return `lifeos-step-${String(step.parentWorkflowNodeRunId)}-${step.stepId}`;
}

function executionStepBlock(
  trace: WorkflowExecutionTraceDto,
  step: ExecutionStepTraceDto,
  seq: number,
): ToolCallBlock {
  const facts = { input: step.input, output: step.output };
  const children = scopedAgentBlocks(
    trace,
    seq,
    facts,
    (activity) =>
      activity.workflowNodeRunId === step.parentWorkflowNodeRunId &&
      activity.executionStepId === step.stepId,
  );
  const summary = terminalSummary(step.status, step.durationMs);
  const output = factOutput(summary, step.output);
  return block({
    callId: executionStepCallId(step),
    name: step.title,
    status: step.status,
    startedAt: step.startedAt ?? trace.run.createdAt,
    ...(step.completedAt === undefined ? {} : { completedAt: step.completedAt }),
    details: {
      stepId: step.stepId,
      status: step.status,
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
      durationMs: step.durationMs ?? null,
      inputFacts: factPayload(step.input),
    },
    summary,
    ...(output === undefined ? {} : { output }),
    subCalls: ordered(children),
    seq,
  });
}

function workflowNodeBlocks(trace: WorkflowExecutionTraceDto, seq: number): ToolCallBlock[] {
  const detailByNode = new Map(
    trace.workflow.nodeDetails.map((detail) => [String(detail.workflowNodeRunId), detail] as const),
  );
  return trace.workflow.nodeRuns.map((node) => {
    const facts = detailByNode.get(String(node.workflowNodeRunId)) ?? { input: [], output: [] };
    const directAgents = scopedAgentBlocks(
      trace,
      seq,
      facts,
      (activity) =>
        activity.workflowNodeRunId === node.workflowNodeRunId &&
        activity.executionStepId === undefined,
    );
    const steps = trace.workflow.executionSteps
      .filter((step) => step.parentWorkflowNodeRunId === node.workflowNodeRunId)
      .map((step) => executionStepBlock(trace, step, seq));
    const details: Record<string, unknown> = {
      nodeType: node.nodeType,
      status: node.status,
      attempt: node.attemptNumber,
      startedAt: node.startedAt ?? node.updatedAt,
      inputFacts: factPayload(facts.input),
      runtimeSpans: runtimeSpansForNode(trace, node.nodeType),
    };
    if (node.finishedAt !== undefined) details.completedAt = node.finishedAt;
    if (node.durationMs !== undefined) details.durationMs = node.durationMs;
    if (node.outcomeCode !== undefined) details.outcome = node.outcomeCode;
    const decision = reviewDecisionLabel(node.nodeType, node.outcomeCode);
    if (decision !== undefined) details.decision = decision;
    if (node.error !== undefined) details.errorCode = node.error.code;
    const summary =
      node.publicSummary ?? terminalSummary(node.status, node.durationMs, node.error?.code);
    const output = factOutput(summary, facts.output);
    return block({
      callId: `lifeos-node-${String(node.workflowNodeRunId)}`,
      name: node.title,
      status: node.status,
      startedAt: node.startedAt ?? node.updatedAt,
      ...(node.finishedAt === undefined ? {} : { completedAt: node.finishedAt }),
      details,
      summary,
      ...(output === undefined ? {} : { output }),
      subCalls: ordered([...directAgents, ...steps]),
      seq,
    });
  });
}

export function executionTraceRoot(
  trace: WorkflowExecutionTraceDto,
  seq: number,
  options: ExecutionTraceViewOptions = {},
  boundaries?: LifeosExecutionTrace["boundaries"],
): ToolCallBlock {
  const firstInput =
    trace.workflow.nodeDetails.find((detail) => detail.input.length > 0)?.input ?? [];
  const workflow = block({
    callId: `lifeos-workflow-${String(trace.productRunId)}`,
    name: `Workflow · ${trace.workflow.title}`,
    status: trace.run.status,
    startedAt: trace.run.createdAt,
    ...(isRunning(trace.run.status) ? {} : { completedAt: trace.run.updatedAt }),
    details: {
      status: trace.run.status,
      phase: trace.run.phase,
      startedAt: trace.run.createdAt,
      updatedAt: trace.run.updatedAt,
      requestFacts: factPayload(firstInput),
      runtimeStartup: rootRuntimeSpans(trace),
    },
    summary: joinedSummary([
      statusLabel(trace.run.status),
      `${String(trace.workflow.nodeRuns.length)} 个 Workflow 节点`,
      formatDuration(instant(trace.run.updatedAt) - instant(trace.run.createdAt)),
    ]),
    // DSH Trajectory只呈现这一套实际Workflow执行。Vercel World事件仍由后端保留为
    // 运行时证据，但不与Workflow NodeRun混排成第二条用户可见流程。
    subCalls: ordered(workflowNodeBlocks(trace, seq)),
    seq,
  });
  if (boundaries === undefined) {
    return decorateTreeBlock(workflow, [], true, options.showTimestamps === true, true);
  }
  const dsh = block({
    callId: `lifeos-boundary-dsh-${boundaries.dsh.dshMessageId}`,
    name: "DSH · 用户输入与原生会话",
    status: "completed",
    startedAt: trace.run.createdAt,
    completedAt: trace.run.createdAt,
    details: {
      dshSessionId: boundaries.dsh.dshSessionId,
      dshMessageId: boundaries.dsh.dshMessageId,
      userTextSha256: boundaries.dsh.userTextSha256,
      ownership: "DSH保存原生交互；Chat不把它当成Product Session。",
    },
    summary: "已接收真实用户消息",
    seq,
  });
  const bridge = block({
    callId: `lifeos-boundary-bridge-${String(trace.productRunId)}`,
    name: "Bridge · 选择、审核与身份映射",
    status: "completed",
    startedAt: trace.run.createdAt,
    completedAt: trace.run.createdAt,
    details: {
      messageCommandId: boundaries.bridge.messageCommandId,
      productUserMessageId: boundaries.bridge.productUserMessageId ?? null,
      productAssistantMessageId: boundaries.bridge.productAssistantMessageId ?? null,
      workflowDefinitionRevisionId: boundaries.bridge.workflowDefinitionRevisionId ?? null,
      promptSelectionSha256: boundaries.bridge.promptSelectionSha256 ?? null,
      ownership: "Bridge只映射并转发，不拥有产品终态。",
    },
    summary: joinedSummary([
      "已绑定Chat命令",
      boundaries.bridge.promptSelectionSha256 === undefined ? undefined : "已冻结提示词选择",
    ]),
    seq,
  });
  const backend = block({
    callId: `lifeos-backend-${String(trace.productRunId)}`,
    name: "Chat 后端 · Product Run 与 Workflow",
    status: trace.run.status,
    startedAt: trace.run.createdAt,
    ...(isRunning(trace.run.status) ? {} : { completedAt: trace.run.updatedAt }),
    details: {
      productRunId: trace.productRunId,
      status: trace.run.status,
      phase: trace.run.phase,
      ownership: "Product Store拥有正式Message/Run；Workflow拥有耐久执行。",
    },
    summary: joinedSummary([statusLabel(trace.run.status), "包含Product事实与Workflow层级"]),
    subCalls: [workflow],
    seq,
  });
  const root = block({
    callId: `lifeos-chat-turn-${String(trace.productRunId)}`,
    name: "Chat 本轮执行",
    status: trace.run.status,
    startedAt: trace.run.createdAt,
    ...(isRunning(trace.run.status) ? {} : { completedAt: trace.run.updatedAt }),
    details: { productRunId: trace.productRunId },
    summary: joinedSummary([statusLabel(trace.run.status), "DSH → Bridge → Chat后端 → Workflow"]),
    subCalls: [dsh, bridge, backend],
    seq,
  });
  return decorateTreeBlock(root, [], true, options.showTimestamps === true, true);
}

/**
 * DSH只认识Tool/Subtool行为；标签只解释Chat领域角色，不改变原生层级与交互。
 */
export function executionTraceCallLabels(
  trace: WorkflowExecutionTraceDto,
  boundaries?: LifeosExecutionTrace["boundaries"],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>([
    [`lifeos-workflow-${String(trace.productRunId)}`, "WORKFLOW"],
  ]);
  if (boundaries !== undefined) {
    labels.set(`lifeos-chat-turn-${String(trace.productRunId)}`, "RUN");
    labels.set(`lifeos-boundary-dsh-${boundaries.dsh.dshMessageId}`, "DSH");
    labels.set(`lifeos-boundary-bridge-${String(trace.productRunId)}`, "BRIDGE");
    labels.set(`lifeos-backend-${String(trace.productRunId)}`, "BACKEND");
  }
  for (const node of trace.workflow.nodeRuns) {
    labels.set(`lifeos-node-${String(node.workflowNodeRunId)}`, "NODE");
  }
  for (const step of trace.workflow.executionSteps) {
    labels.set(executionStepCallId(step), "STEP");
  }
  for (const activity of trace.piActivities) {
    labels.set(
      `lifeos-${activity.activityKey}`,
      activity.kind === "agent" ? "AGENT" : activity.kind === "model" ? "MODEL" : "TOOL",
    );
  }
  return labels;
}

interface ExecutionTraceCallPreview {
  readonly input?: string;
  readonly output?: string;
}

/**
 * 列表只显示稳定摘要；原始argsRaw与完整ToolResult仍由DSH放在点击后的Payload/Result。
 * 这是显示投影，不删除或改写任何Chat运行事实。
 */
export function executionTraceCallPreviews(
  root: ToolCallBlock,
): ReadonlyMap<string, ExecutionTraceCallPreview> {
  const previews = new Map<string, ExecutionTraceCallPreview>();
  const visit = (value: ToolCallBlock): void => {
    let output: string | undefined;
    if ("kind" in value) {
      for (const item of value.content) {
        if (item.type !== "text" || item.text.trim() === "") continue;
        output = item.text.split(/\r?\n/u, 1)[0];
        break;
      }
    }
    previews.set(value.callId, {
      input: "",
      ...(output === undefined ? {} : { output }),
    });
    for (const child of value.subCalls) visit(child);
  };
  visit(root);
  return previews;
}

function locationTurn(
  location: ConversationNodeContext["matches"][number]["location"],
): number | undefined {
  if (location.kind === "step" || location.kind === "turn") return location.turn.turn;
  return undefined;
}

/** 保存真实user/message到Product Run的绑定，不产生可见Trajectory节点。 */
export function createExecutionTraceBindingDefinition(
  traceForMessage: ExecutionTraceForMessage,
): ConversationNodeDefinition<LifeosExecutionTrace> {
  return {
    kind: EXECUTION_TRACE_BINDING_KIND,
    match: (event) => {
      if (event.type !== "user/message" || event.data.source.kind !== "user") return null;
      const trace = traceForMessage(String(event.data.id));
      return trace === undefined ? null : { id: String(trace.trace.productRunId), role: "start" };
    },
    start: (_context, match) => {
      if (match.event.type !== "user/message") {
        throw new Error("lifeos execution trace requires its triggering user message");
      }
      const trace = traceForMessage(String(match.event.data.id));
      if (trace === undefined) {
        throw new Error("lifeos execution trace binding disappeared during projection");
      }
      return trace;
    },
    update: (context) => context.state,
  };
}

/**
 * request/header发生在本轮User/Context之后、Assistant之前，并携带DSH解析的Step
 * Location。通过严格向前读取消息绑定，Workflow树进入真实Step而不是Turn序言。
 */
export function createExecutionTraceDefinition(
  options: ExecutionTraceViewOptions = {},
): ConversationNodeDefinition<ExecutionTracePlacementState> {
  return {
    kind: "lifeos-execution-trace",
    target: "trajectory",
    match: (event) =>
      event.type === "request/header" ? { id: String(event.seq), role: "start" } : null,
    start: (_context, match, reader) => {
      const binding = reader.previous<LifeosExecutionTrace>(EXECUTION_TRACE_BINDING_KIND);
      if (binding === undefined) return {};
      const bindingLocation = binding.matches.at(-1)?.location;
      const bindingTurn = bindingLocation === undefined ? undefined : locationTurn(bindingLocation);
      const requestTurn = locationTurn(match.location);
      if (bindingTurn !== undefined && requestTurn !== undefined && bindingTurn !== requestTurn) {
        return {};
      }
      return { value: binding.state };
    },
    update: (context) => context.state,
    buildViewNode: (context: ConversationNodeContext<ExecutionTracePlacementState>) => {
      const last = context.matches.at(-1);
      const value = context.state?.value;
      if (last === undefined || value === undefined) return null;
      const root = executionTraceRoot(value.trace, last.event.seq, options, value.boundaries);
      return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: "trajectory",
        anchorSeq: context.start?.event.seq ?? last.event.seq,
        location: context.start?.location ?? { kind: "unresolved" },
        data: {
          kind: "tool",
          root,
          callLabels: executionTraceCallLabels(value.trace, value.boundaries),
          callPreviews: executionTraceCallPreviews(root),
        },
      };
    },
  };
}

export function registerExecutionTraceDefinition(
  ctx: {
    conversationEvents: { register(definition: ConversationNodeDefinition): () => void };
  },
  traceForMessage: ExecutionTraceForMessage,
  options: ExecutionTraceViewOptions = {},
): () => void {
  const disposeBinding = ctx.conversationEvents.register(
    createExecutionTraceBindingDefinition(traceForMessage),
  );
  const disposeVisible = ctx.conversationEvents.register(createExecutionTraceDefinition(options));
  return () => {
    disposeVisible();
    disposeBinding();
  };
}

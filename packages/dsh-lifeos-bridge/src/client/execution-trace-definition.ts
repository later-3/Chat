import type { ExecutionTraceDto, PiTraceActivityDto } from "@chat/contracts/public";
import type {
  ConversationNodeContext,
  ConversationNodeDefinition,
  ToolCallBlock,
} from "@deepseek-ai/dsh-client-runtime/client";

type PublicStatus =
  | ExecutionTraceDto["run"]["status"]
  | ExecutionTraceDto["workflow"]["nodeRuns"][number]["status"]
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
  readonly details: Record<string, string | number | boolean>;
  readonly summary?: string;
  readonly subCalls?: readonly ToolCallBlock[];
  readonly seq: number;
}

export interface ExecutionTraceViewOptions {
  /** 在每一行结果摘要中显示浏览器本地时间范围；默认保持紧凑。 */
  readonly showTimestamps?: boolean;
}

export type ExecutionTraceForMessage = (dshMessageId: string) => ExecutionTraceDto | undefined;

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
};

const AGENT_ROLE_LABEL: Record<PiTraceActivityDto["nodeKind"], string> = {
  planner: "规划",
  executor: "执行",
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
  return ["failed", "cancelled", "outcome_unknown"].includes(status);
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
    content: [{ type: "text", text: summary }],
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
): ToolCallBlock {
  const details: Record<string, string | number | boolean> = {
    kind: activity.kind,
    status: activity.status,
    startedAt: activity.startedAt,
  };
  if (activity.completedAt !== undefined) details.completedAt = activity.completedAt;
  if (activity.provider !== undefined) details.provider = activity.provider;
  if (activity.model !== undefined) details.model = activity.model;
  if (activity.toolName !== undefined) details.tool = activity.toolName;
  if (activity.tokenUsage !== undefined) {
    details.promptTokens = activity.tokenUsage.promptTokens;
    details.completionTokens = activity.tokenUsage.completionTokens;
    details.totalTokens = activity.tokenUsage.totalTokens;
  }
  if (activity.durationMs !== undefined) details.durationMs = activity.durationMs;
  if (activity.errorCode !== undefined) details.errorCode = activity.errorCode;
  return block({
    callId: `lifeos-${activity.activityKey}`,
    name: activityName(activity),
    status: activity.status,
    startedAt: activity.startedAt,
    ...(activity.completedAt === undefined ? {} : { completedAt: activity.completedAt }),
    details,
    summary: activitySummary(activity, children),
    subCalls: ordered(children.map((child) => activityBlock(child, [], seq))),
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

function nodeKind(nodeType: string): PiTraceActivityDto["nodeKind"] | undefined {
  if (nodeType === "agent.plan") return "planner";
  if (nodeType.startsWith("execute.")) return "executor";
  if (nodeType.includes("note") && nodeType.startsWith("agent.")) return "note_capture";
  return undefined;
}

function workflowNodeBlocks(trace: ExecutionTraceDto, seq: number): ToolCallBlock[] {
  const assignments = assignAgents(trace);
  return trace.workflow.nodeRuns.map((node) => {
    const children = (assignments.get(String(node.workflowNodeRunId)) ?? []).map((agent) =>
      activityBlock(
        agent,
        trace.piActivities.filter((activity) => activity.parentActivityKey === agent.activityKey),
        seq,
      ),
    );
    const details: Record<string, string | number | boolean> = {
      nodeType: node.nodeType,
      status: node.status,
      attempt: node.attemptNumber,
      startedAt: node.startedAt ?? node.updatedAt,
    };
    if (node.finishedAt !== undefined) details.completedAt = node.finishedAt;
    if (node.durationMs !== undefined) details.durationMs = node.durationMs;
    if (node.outcomeCode !== undefined) details.outcome = node.outcomeCode;
    const decision = reviewDecisionLabel(node.nodeType, node.outcomeCode);
    if (decision !== undefined) details.decision = decision;
    if (node.error !== undefined) details.errorCode = node.error.code;
    return block({
      callId: `lifeos-node-${String(node.workflowNodeRunId)}`,
      name: node.title,
      status: node.status,
      startedAt: node.startedAt ?? node.updatedAt,
      ...(node.finishedAt === undefined ? {} : { completedAt: node.finishedAt }),
      details,
      summary:
        node.publicSummary ?? terminalSummary(node.status, node.durationMs, node.error?.code),
      subCalls: ordered(children),
      seq,
    });
  });
}

function assignAgents(
  trace: ExecutionTraceDto,
): ReadonlyMap<string, readonly PiTraceActivityDto[]> {
  const assignments = new Map<string, PiTraceActivityDto[]>();
  const agents = trace.piActivities.filter((activity) => activity.kind === "agent");
  for (const agent of agents) {
    const agentStartedAt = instant(agent.startedAt);
    const candidates = trace.workflow.nodeRuns
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => nodeKind(node.nodeType) === agent.nodeKind)
      .map(({ node, index }) => {
        const start = instant(node.startedAt ?? node.updatedAt);
        const end = instant(node.finishedAt ?? node.updatedAt);
        return {
          node,
          index,
          contains:
            agentStartedAt >= Math.min(start, end) && agentStartedAt <= Math.max(start, end),
          duration: Math.abs(end - start),
          distance: Math.abs(agentStartedAt - start),
          // Executor优先落到实际Plan Step，不被外层execute.plan容器吞掉。
          specificity: node.nodeType === "execute.plan_step" ? 0 : 1,
        };
      })
      .sort(
        (left, right) =>
          Number(right.contains) - Number(left.contains) ||
          left.specificity - right.specificity ||
          left.duration - right.duration ||
          left.distance - right.distance ||
          left.index - right.index,
      );
    const selected = candidates[0]?.node;
    if (selected === undefined) continue;
    const key = String(selected.workflowNodeRunId);
    const assigned = assignments.get(key) ?? [];
    assigned.push(agent);
    assignments.set(key, assigned);
  }
  return assignments;
}

export function executionTraceRoot(
  trace: ExecutionTraceDto,
  seq: number,
  options: ExecutionTraceViewOptions = {},
): ToolCallBlock {
  const root = block({
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
  return decorateTreeBlock(root, [], true, options.showTimestamps === true, true);
}

export function createExecutionTraceDefinition(
  traceForMessage: ExecutionTraceForMessage,
  options: ExecutionTraceViewOptions = {},
): ConversationNodeDefinition<ExecutionTraceDto> {
  return {
    kind: "lifeos-execution-trace",
    target: "trajectory",
    // user/message是Product Run的真实触发点。外部轨迹通过Bridge保存的消息绑定
    // 查询得到，不向DSH Session追加自定义事件，也不伪装成任何原生工具事件。
    match: (event) => {
      if (event.type !== "user/message" || event.data.source.kind !== "user") return null;
      const trace = traceForMessage(String(event.data.id));
      return trace === undefined ? null : { id: String(trace.productRunId), role: "start" };
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
    buildViewNode: (context: ConversationNodeContext<ExecutionTraceDto>) => {
      const last = context.matches.at(-1);
      if (last === undefined || context.state === undefined) return null;
      return {
        key: context.key,
        kind: context.kind,
        id: context.id,
        target: "trajectory",
        anchorSeq: context.start?.event.seq ?? last.event.seq,
        location: context.start?.location ?? { kind: "unresolved" },
        data: {
          kind: "tool",
          root: executionTraceRoot(context.state, last.event.seq, options),
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
  return ctx.conversationEvents.register(createExecutionTraceDefinition(traceForMessage, options));
}

import { dirname, resolve } from "node:path";
import {
  buildContextEntries,
  buildSessionContext,
  sessionEntryToContextMessages,
  SessionManager,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { openProject, resolveProjectContext } from "./projects/registry.js";
import { firstSessionUtterance, listActiveSessionFiles } from "./session-files.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import {
  collectChatWorkflowStageMarkers,
} from "./workflows/workflow-stage.js";
import {
  collectChatSubsessionRelation,
  collectChatWorkflowCalls,
  collectChatWorkflowDelegationOrigins,
  resolveChatWorkflowDelegationOrigins,
  type ChatWorkflowDelegationOrigin,
} from "./workflows/workflow-call-state.js";
import {
  collectChatWorkflowCallProjection,
  projectChatWorkflowCallTree,
} from "./workflows/workflow-call-statistics.js";
import {
  collectChatWorkflowTurnConfigurations,
  collectLatestChatWorkflowConfigurations,
} from "./workflows/workflow-configuration.js";
import { collectChatToolExecutions } from "./tools/execution-record.js";
import { collectChatPromptResourceProposals } from "./workflows/prompt-resource-proposal.js";
import {
  collectPlanReviewDecisions,
  collectPendingPlanReview,
  findActivePlanningExecutionRun,
  isTerminalPlanningExecutionPhase,
  listActivePlanningExecutionRuns,
  planReviewDecisionMessage,
  type PlanningExecutionRunRecord,
} from "./workflows/planning-execution/review-state.js";

export interface ChatSessionAttention {
  readonly kind: "review" | "clarification";
  readonly workflowId: string;
  readonly updatedAt: string;
}

export interface ChatSessionListItem {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  attention?: ChatSessionAttention;
  projectRoot: string;
  projectAvailable: true;
  projectKey: string;
  transient: false;
  sessionSource: "chat";
  readOnly: false;
  projectId?: string;
}

async function toListItems(
  infos: SessionInfo[],
  projectId?: string,
  activePlanningBySessionId: ReadonlyMap<string, PlanningExecutionRunRecord> = new Map(),
): Promise<ChatSessionListItem[]> {
  const idByPath = new Map(infos.map((info) => [resolve(info.path), info.id]));
  return Promise.all(infos.map(async (info) => {
    const relation = collectChatSubsessionRelation(
      SessionManager.open(info.path, dirname(info.path)).getEntries(),
    );
    const parentSessionId = relation?.parentSessionId ?? (info.parentSessionPath === undefined
      ? undefined
      : idByPath.get(resolve(info.parentSessionPath)));
    const planning = activePlanningBySessionId.get(info.id);
    const attention = planning?.phase !== "waiting_review" || planning.currentReview === undefined
      ? undefined
      : {
          kind: planning.currentReview.readiness === "needs_clarification"
            ? "clarification" as const
            : "review" as const,
          workflowId: planning.workflowId,
          updatedAt: planning.updatedAt,
        };
    return {
      path: info.path,
      id: info.id,
      cwd: info.cwd,
      ...(info.name === undefined ? {} : { name: info.name }),
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
      firstMessage: firstSessionUtterance(info),
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(attention === undefined ? {} : { attention }),
      projectRoot: info.cwd,
      projectAvailable: true,
      projectKey: projectId ?? info.cwd,
      transient: false,
      sessionSource: "chat",
      readOnly: false,
      ...(projectId === undefined ? {} : { projectId }),
    };
  }));
}

async function resolveSessionProject(projectId?: string, chatHome?: string) {
  return projectId === undefined
    ? openProject({
        path: process.cwd(),
        ...(chatHome === undefined ? {} : { chatHome }),
      })
    : resolveProjectContext(projectId, chatHome);
}

async function rethrowWithCurrentSessionState(
  projectId: string,
  chatHome: string | undefined,
  sessionId: string,
  originalError: unknown,
): Promise<never> {
  await requireActiveChatSessionFile(await resolveProjectContext(projectId, chatHome), sessionId);
  throw originalError;
}

/** Lists one registered Project; cwd is resolved through its Project Manifest when omitted. */
export async function listChatSessions(projectId?: string, chatHome?: string): Promise<ChatSessionListItem[]> {
  const project = await resolveSessionProject(projectId, chatHome);
  const [infos, activePlanning] = await Promise.all([
    listActiveSessionFiles(project),
    listActivePlanningExecutionRuns(project.projectDataDir),
  ]);
  const activePlanningBySessionId = new Map<string, PlanningExecutionRunRecord>();
  for (const record of activePlanning) {
    if (record.sessionId !== undefined && !activePlanningBySessionId.has(record.sessionId)) {
      activePlanningBySessionId.set(record.sessionId, record);
    }
  }
  return toListItems(infos, project.projectId, activePlanningBySessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi保存的ToolCall使用`id/name/arguments`，Pi Web前端使用另一组字段名。 */
export function normalizeMessageForFrontend(message: unknown): unknown {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((block) => {
      if (!isRecord(block) || block.type !== "toolCall") return block;
      return {
        type: "toolCall",
        toolCallId: typeof block.toolCallId === "string"
          ? block.toolCallId
          : (typeof block.id === "string" ? block.id : ""),
        toolName: typeof block.toolName === "string"
          ? block.toolName
          : (typeof block.name === "string" ? block.name : ""),
        input: isRecord(block.input)
          ? block.input
          : (isRecord(block.arguments) ? block.arguments : {}),
      };
    }),
  };
}

export interface SessionProjectionOptions {
  readonly deferThinking?: boolean;
  readonly deferToolResultImages?: boolean;
}

function nativeMessageForFrontend(
  message: unknown,
  stage: ReturnType<typeof collectChatWorkflowStageMarkers>[number] | undefined,
  delegationOrigin?: ChatWorkflowDelegationOrigin,
): unknown {
  const normalized = normalizeMessageForFrontend(message);
  if (!isRecord(normalized)) {
    return normalized;
  }
  if (normalized.role === "user" && delegationOrigin !== undefined) {
    return {
      ...normalized,
      chatWorkflow: {
        invocationId: delegationOrigin.source.workflowInvocationId,
        workflowId: delegationOrigin.source.workflowId,
        stageId: delegationOrigin.source.stageId,
        agentId: delegationOrigin.source.agentId,
      },
    };
  }
  if (normalized.role !== "assistant" || stage?.agentId === undefined) return normalized;
  return {
    ...normalized,
    chatWorkflow: {
      invocationId: stage.invocationId,
      workflowId: stage.workflowId,
      stageId: stage.stageId,
      agentId: stage.agentId,
    },
  };
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;
  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), ...(mime ? { mime } : {}) };
}

function applyProjectionOptions(message: unknown, options: SessionProjectionOptions): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  if (options.deferThinking && message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((block) => (
        isRecord(block) && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== ""
          ? { ...block, thinking: "", deferred: true }
          : block
      )),
    };
  }
  if (!options.deferToolResultImages || message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;
  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  return {
    ...message,
    content: [...content, {
      type: "text",
      text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
    }],
  };
}

/** 使用Pi自己的分支与压缩选择逻辑，同时生成与消息一一对应的前端节点ID。 */
export function projectSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: SessionProjectionOptions = {},
  delegationOrigins: readonly ChatWorkflowDelegationOrigin[] = collectChatWorkflowDelegationOrigins(entries),
) {
  const contextEntries = buildContextEntries(entries, leafId);
  const context = buildSessionContext(entries, leafId);
  const messages: unknown[] = [];
  const entryIds: string[] = [];
  const stageByEntryId = new Map(
    collectChatWorkflowStageMarkers(contextEntries).map((stage) => [stage.entryId, stage]),
  );
  const reviewDecisionByEntryId = new Map(
    collectPlanReviewDecisions(contextEntries).map((decision) => [decision.entryId, decision]),
  );
  const delegationOriginByTargetInvocationId = new Map(
    delegationOrigins
      .map((origin) => [origin.target.workflowInvocationId, origin]),
  );
  const projectedDelegationInvocations = new Set<string>();
  let activeStage = undefined as ReturnType<typeof collectChatWorkflowStageMarkers>[number] | undefined;

  for (const entry of contextEntries) {
    const stage = stageByEntryId.get(entry.id);
    if (stage !== undefined) {
      activeStage = stage;
      continue;
    }
    const reviewDecision = reviewDecisionByEntryId.get(entry.id);
    const reviewMessageEntryId = reviewDecision?.messageEntryId ?? reviewDecision?.feedbackEntryId;
    if (reviewDecision !== undefined && reviewMessageEntryId === undefined) {
      messages.push({
        role: "custom",
        customType: "chat.plan_review_decision",
        content: reviewDecision.kind === "approve"
          ? planReviewDecisionMessage(reviewDecision)
          : `计划修改意见：${reviewDecision.feedback}`,
        display: true,
        details: {
          kind: reviewDecision.kind,
          reviewId: reviewDecision.reviewId,
          planRevision: reviewDecision.planRevision,
        },
        timestamp: Date.parse(reviewDecision.decidedAt),
      });
      entryIds.push(reviewDecision.entryId);
    }
    for (const message of sessionEntryToContextMessages(entry)) {
      if (isRecord(message) && message.role === "custom" && message.display === false) continue;
      const delegationOrigin = isRecord(message) && message.role === "user" && activeStage !== undefined
        && !projectedDelegationInvocations.has(activeStage.invocationId)
        ? delegationOriginByTargetInvocationId.get(activeStage.invocationId)
        : undefined;
      if (delegationOrigin !== undefined && activeStage !== undefined) {
        projectedDelegationInvocations.add(activeStage.invocationId);
      }
      messages.push(applyProjectionOptions(
        nativeMessageForFrontend(message, activeStage, delegationOrigin),
        options,
      ));
      entryIds.push(entry.id);
    }
  }
  return {
    messages,
    entryIds,
    thinkingLevel: context.thinkingLevel,
    model: context.model,
  };
}

/** Resolves a browser-provided ID only against Chat's managed Session directory. */
export async function requireChatSession(
  sessionId: string,
  projectId?: string,
  chatHome?: string,
): Promise<ChatSessionListItem> {
  const project = await resolveSessionProject(projectId, chatHome);
  const active = await requireActiveChatSessionFile(project, sessionId);
  try {
    const [session] = await toListItems([active], project.projectId);
    if (session === undefined) throw new Error(`找不到Session: ${sessionId}`);
    return session;
  } catch (error) {
    return rethrowWithCurrentSessionState(project.projectId, chatHome, sessionId, error);
  }
}

export async function readChatSession(
  sessionId: string,
  leafId?: string | null,
  options: SessionProjectionOptions = {},
  projectId?: string,
  chatHome?: string,
) {
  const info = await requireChatSession(sessionId, projectId, chatHome);
  let manager: SessionManager;
  let entries: SessionEntry[];
  try {
    manager = SessionManager.open(info.path, dirname(info.path));
    entries = manager.getEntries();
    if (manager.getSessionId() !== sessionId) {
      throw new Error(`Session文件在读取时不可用: ${sessionId}`);
    }
  } catch (error) {
    return rethrowWithCurrentSessionState(info.projectId as string, chatHome, sessionId, error);
  }
  if (leafId && manager.getEntry(leafId) === undefined) {
    throw new Error(`找不到Session节点: ${leafId}`);
  }

  const selectedLeafId = leafId === undefined ? manager.getLeafId() : leafId;
  const context = projectSessionContext(
    entries,
    selectedLeafId,
    options,
    await resolveChatWorkflowDelegationOrigins(manager),
  );
  const pendingPlanReview = collectPendingPlanReview(entries);
  let activePlanningExecution;
  let workflowCallProjection;
  if (info.projectId !== undefined) {
    const project = await resolveProjectContext(info.projectId, chatHome);
    workflowCallProjection = await collectChatWorkflowCallProjection({
      rootSessionId: manager.getSessionId(),
      rootEntries: entries,
      sessionDir: project.sessionDir,
    });
    const record = await findActivePlanningExecutionRun(
      project.projectDataDir,
      manager.getSessionId(),
    );
    if (record?.runId !== undefined && !isTerminalPlanningExecutionPhase(record.phase)) {
      activePlanningExecution = {
        runId: record.runId,
        workflowId: record.workflowId,
        workflowInvocationId: record.workflowInvocationId,
        phase: record.phase,
        ...(pendingPlanReview?.workflowInvocationId !== record.workflowInvocationId
          ? {}
          : { review: pendingPlanReview }),
      };
    }
  } else {
    workflowCallProjection = projectChatWorkflowCallTree(
      manager.getSessionId(),
      new Map([[manager.getSessionId(), collectChatWorkflowCalls(entries)]]),
    );
  }

  return {
    session: info,
    sessionId: manager.getSessionId(),
    filePath: info.path,
    totalActiveMs: 0,
    tree: manager.getTree(),
    leafId: selectedLeafId ?? null,
    context: {
      messages: context.messages,
      entryIds: context.entryIds,
      thinkingLevel: context.thinkingLevel,
      model: context.model,
    },
    workflowConfigurations: collectLatestChatWorkflowConfigurations(entries),
    workflowTurnConfigurations: collectChatWorkflowTurnConfigurations(entries),
    workflowCalls: collectChatWorkflowCalls(entries),
    ...workflowCallProjection,
    toolExecutions: collectChatToolExecutions(entries),
    promptResourceProposals: collectChatPromptResourceProposals(entries),
    ...(activePlanningExecution === undefined ? {} : { activePlanningExecution }),
  };
}

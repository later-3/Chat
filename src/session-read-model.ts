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
  collectChatWorkflowTurnConfigurations,
  collectLatestChatWorkflowConfigurations,
} from "./workflows/workflow-configuration.js";
import { collectChatToolExecutions } from "./tools/execution-record.js";
import { collectChatPromptResourceProposals } from "./workflows/prompt-resource-proposal.js";
import {
  collectPlanReviewDecisions,
  collectPendingPlanReview,
  findActivePlanningExecutionRun,
  getPlanningExecutionRun,
  isTerminalPlanningExecutionPhase,
  planReviewDecisionMessage,
} from "./workflows/planning-execution/review-state.js";

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
  projectRoot: string;
  projectAvailable: true;
  projectKey: string;
  transient: false;
  sessionSource: "chat";
  readOnly: false;
  projectId?: string;
}

async function toListItems(infos: SessionInfo[], projectId?: string): Promise<ChatSessionListItem[]> {
  const idByPath = new Map(infos.map((info) => [resolve(info.path), info.id]));
  return Promise.all(infos.map(async (info) => {
    const parentSessionId = info.parentSessionPath === undefined
      ? undefined
      : idByPath.get(resolve(info.parentSessionPath));
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
  const infos = await listActiveSessionFiles(project);
  return toListItems(infos, project.projectId);
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
): unknown {
  const normalized = normalizeMessageForFrontend(message);
  if (!isRecord(normalized) || normalized.role !== "assistant" || stage?.agentId === undefined) {
    return normalized;
  }
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
      messages.push(applyProjectionOptions(nativeMessageForFrontend(message, activeStage), options));
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
  const context = projectSessionContext(entries, selectedLeafId, options);
  const pendingPlanReview = collectPendingPlanReview(entries);
  let activePlanningExecution;
  const latestPlanningInvocationId = collectChatWorkflowStageMarkers(entries)
    .filter((stage) => stage.workflowId === "planning-execution")
    .at(-1)?.invocationId
    ?? collectChatWorkflowTurnConfigurations(entries)
      .filter((snapshot) => snapshot.workflowId === "planning-execution")
      .at(-1)?.invocationId;
  const activeInvocationId = pendingPlanReview?.workflowInvocationId ?? latestPlanningInvocationId;
  if (activeInvocationId !== undefined && info.projectId !== undefined) {
    const project = await resolveProjectContext(info.projectId, chatHome);
    const record = await getPlanningExecutionRun(
      project.projectDataDir,
      activeInvocationId,
    );
    if (record?.runId !== undefined && record.sessionId === manager.getSessionId()
      && !isTerminalPlanningExecutionPhase(record.phase)) {
      activePlanningExecution = {
        runId: record.runId,
        workflowInvocationId: record.workflowInvocationId,
        phase: record.phase,
        ...(pendingPlanReview === undefined ? {} : { review: pendingPlanReview }),
      };
    }
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
    toolExecutions: collectChatToolExecutions(entries),
    promptResourceProposals: collectChatPromptResourceProposals(entries),
    ...(activePlanningExecution === undefined ? {} : { activePlanningExecution }),
  };
}

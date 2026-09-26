import { readLegacyFriendSessions } from "./migrations/agent-home-normalization.js";
import { readWritableFriendSessionIds } from "./session-owner.js";
import { readSessionFriendExecution } from "./long-agents/turn-feedback.js";
import { resolveChatHome } from "./chat-home.js";
import { projectLongAgentActivity } from "./long-agents/session-activity.js";
import { isChatSessionOperationBusy } from "./session-operation-lock.js";
import { dirname, resolve } from "node:path";
import { readSessionWorkflowActivity } from "./session-workflow-activity.js";
import { readChatSessionRunOutcome } from "./workflows/session-run-registry.js";
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
import {
  chatSessionOwner,
  readChatSessionOwnerIndex,
  type ChatSessionOwner,
} from "./session-owner.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import {
  collectChatWorkflowStageMarkers,
} from "./workflows/workflow-stage.js";
import {
  collectChatLongAgentTurnMarkers,
  type ChatLongAgentTurnMarker,
} from "./long-agents/session-turn.js";
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
  decodeBoundedToolResultImage,
  MAX_TOOL_RESULT_IMAGE_BYTES,
  readBase64ToolResultImage,
  TOOL_RESULT_IMAGE_MIMES,
} from "./session-tool-result-images.js";
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
  readOnly: boolean;
  owner: ChatSessionOwner;
  projectId?: string;
}

async function toListItems(
  infos: SessionInfo[],
  projectId: string,
  chatHome?: string,
  activePlanningBySessionId: ReadonlyMap<string, PlanningExecutionRunRecord> = new Map(),
): Promise<ChatSessionListItem[]> {
  const owners = await readChatSessionOwnerIndex(projectId, chatHome);
  const writableFriends = await readWritableFriendSessionIds(chatHome);
  const migrated = await readLegacyFriendSessions(resolveChatHome(chatHome));
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
      readOnly: (chatSessionOwner(owners, info.id).type === "long-agent" && !writableFriends.has(info.id))
        || migrated.some((entry) => entry.sessionId === info.id && entry.targetProjectId === projectId && entry.sourceProjectId !== entry.targetProjectId),
      owner: chatSessionOwner(owners, info.id),
      projectId,
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
  return toListItems(infos, project.projectId, chatHome, activePlanningBySessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将原生 Pi 消息投影到两个 Web 入口共用的展示合同；不改写 Session。 */
export function normalizeMessageForFrontend(message: unknown): unknown {
  if (isRecord(message) && (message.role === "compactionSummary" || message.role === "branchSummary")
    && typeof message.summary === "string") {
    return {
      role: "custom",
      customType: message.role === "compactionSummary" ? "compaction" : "branch-summary",
      content: message.summary,
      display: true,
      ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
      details: message.role === "compactionSummary"
        ? { tokensBefore: message.tokensBefore }
        : { fromId: message.fromId },
    };
  }
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
  /** Used only to build same-session lazy URLs for deferred tool-result images. */
  readonly sessionId?: string;
  /** Preserves the Project boundary when a browser later requests a deferred image. */
  readonly projectId?: string;
}

function nativeMessageForFrontend(
  message: unknown,
  stage: ReturnType<typeof collectChatWorkflowStageMarkers>[number] | undefined,
  delegationOrigin?: ChatWorkflowDelegationOrigin,
  longAgentTurn?: ChatLongAgentTurnMarker,
): unknown {
  const normalized = normalizeMessageForFrontend(message);
  if (!isRecord(normalized)) {
    return normalized;
  }
  // A relayed native user message keeps its Chat-owned association so the frontend can show the source.
  if (normalized.role === "user" && isRecord((message as Record<string, unknown>).chatTopicRelay)) {
    return { ...normalized, chatTopicRelay: (message as Record<string, unknown>).chatTopicRelay };
  }
  if ((normalized.role === "user" || normalized.role === "assistant")
    && longAgentTurn !== undefined
    && !isRecord(normalized.chatLongAgent)) {
    return {
      ...normalized,
      chatLongAgent: {
        source: "chat.long_agent",
        eventId: longAgentTurn.inboundEventId ?? `chat-web:${longAgentTurn.turnId}`,
        messageId: longAgentTurn.turnId,
        turnId: longAgentTurn.turnId,
        bindingId: longAgentTurn.bindingId,
        longAgentId: longAgentTurn.longAgentId,
        nanoclawSessionId: null,
        direction: normalized.role === "user" ? "in" : "out",
        channelType: longAgentTurn.channelType,
        native: true,
      },
    };
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

function deferredToolResultImageUrl(
  sessionId: string,
  entryId: string,
  blockIndex: number,
  projectId?: string,
): string {
  const query = new URLSearchParams({ blockIndex: String(blockIndex) });
  if (projectId !== undefined) query.set("projectId", projectId);
  return `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?${query.toString()}`;
}

function applyProjectionOptions(message: unknown, entryId: string, options: SessionProjectionOptions): unknown {
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
  const content = message.content.flatMap((block, blockIndex) => {
    const image = readBase64ToolResultImage(block);
    if (!image) return [block];
    if (
      options.sessionId !== undefined &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      return [{
        type: "image",
        source: {
          type: "url",
          media_type: image.mime,
          url: deferredToolResultImageUrl(
            options.sessionId,
            entryId,
            blockIndex,
            options.projectId,
          ),
        },
      }];
    }
    omitted += 1;
    bytes += image.bytes;
    mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };
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
  const entryTimes: (number | null)[] = [];
  const stageByEntryId = new Map(
    collectChatWorkflowStageMarkers(contextEntries).map((stage) => [stage.entryId, stage]),
  );
  const longAgentTurnByEntryId = new Map(
    collectChatLongAgentTurnMarkers(contextEntries).map((turn) => [turn.entryId, turn]),
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
  let activeLongAgentTurn = undefined as ChatLongAgentTurnMarker | undefined;

  for (const entry of contextEntries) {
    const stage = stageByEntryId.get(entry.id);
    if (stage !== undefined) {
      activeStage = stage;
      continue;
    }
    const longAgentTurn = longAgentTurnByEntryId.get(entry.id);
    if (longAgentTurn !== undefined) {
      activeLongAgentTurn = longAgentTurn.status === "running" ? longAgentTurn : undefined;
      if (longAgentTurn.status === "running") activeStage = undefined;
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
      entryTimes.push(Date.parse(reviewDecision.decidedAt));
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
        nativeMessageForFrontend(message, activeStage, delegationOrigin, activeLongAgentTurn),
        entry.id,
        options,
      ));
      entryIds.push(entry.id);
      const recordedAt = Date.parse(entry.timestamp);
      entryTimes.push(Number.isFinite(recordedAt) ? recordedAt : null);
    }
  }
  return {
    messages,
    entryIds,
    entryTimes,
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
  // Resolve only an exact migration receipt, never search another Project after an error.
  const legacy = projectId === undefined ? undefined : (await readLegacyFriendSessions(resolveChatHome(chatHome)))
    .find((entry) => entry.sourceProjectId === projectId && entry.sessionId === sessionId);
  const project = await resolveSessionProject(legacy?.targetProjectId ?? projectId, chatHome);
  const active = await requireActiveChatSessionFile(project, sessionId);
  try {
    const [session] = await toListItems([active], project.projectId, chatHome);
    if (session === undefined) throw new Error(`找不到Session: ${sessionId}`);
    return session;
  } catch (error) {
    return rethrowWithCurrentSessionState(project.projectId, chatHome, sessionId, error);
  }
}

export type ChatToolResultImageRead =
  | { readonly status: "ok"; readonly bytes: Uint8Array; readonly mime: string }
  | { readonly status: "not-found" }
  | { readonly status: "unsupported" }
  | { readonly status: "invalid-or-oversized" };

/**
 * Shared read-entry guard for a resolved Session file. A Session without a group participation
 * binding is unaffected; a group participation Session is refused unless the caller declared a
 * reader that is still authorized, so revocation, re-joining or guessing another participant's
 * Session ID cannot bypass the group projection through a generic entry (detail, context, export,
 * transcript, attachment/tool-result media).
 */
async function assertSessionFileReadable(input: {
  chatHome?: string;
  sessionPath: string;
  sessionId: string;
  /** Storage project of this Session; required to consult the topic graph. */
  storageProjectId?: string;
  requester: import("./long-agents/conversations/access.js").SessionRequester | null;
}): Promise<void> {
  const { participationBindingOf, assertParticipantSessionReadable } = await import("./long-agents/conversations/access.js");
  const binding = participationBindingOf(SessionManager.open(input.sessionPath, dirname(input.sessionPath)).getEntries());
  if (binding !== null) {
    if (input.requester === null) throw new Error("群参与 Session 需要明确的读取身份：普通读取入口不能绕过群授权");
    await assertParticipantSessionReadable({
      chatHome: input.chatHome ?? resolveChatHome(),
      storageProjectId: binding.storageProjectId,
      sessionId: input.sessionId,
      requester: input.requester,
    });
  }
  // Topic nodes: EVERY session read entry (detail, history, transcript, export, node API, streams) goes
  // through the shared topic decision, so the tool/domain rules cannot be bypassed by reading the
  // session directly. A Session without a topic node is unaffected.
  if (input.storageProjectId === undefined) return;
  const { authorizeTopicSession, readTopicGraph } = await import("./long-agents/topics.js");
  const graph = await readTopicGraph(input.chatHome ?? resolveChatHome(), input.storageProjectId);
  const topicRequester = input.requester === null || input.requester.kind === "owner"
    ? { kind: "user" as const }
    : { kind: "agent" as const, longAgentId: input.requester.longAgentId };
  const decision = authorizeTopicSession({ graph, requester: topicRequester, sessionId: input.sessionId, capability: "read" });
  if (decision.applicable && !decision.allowed)
    throw new Error(decision.reason ?? "没有读取该主题节点的权限");
}

/** Exported so owner-facing entry points (export/transcript) apply the same guard before reading. */
export async function assertChatSessionReadable(input: {
  sessionId: string;
  projectId?: string;
  chatHome?: string;
  requester: import("./long-agents/conversations/access.js").SessionRequester | null;
}): Promise<void> {
  const info = await requireChatSession(input.sessionId, input.projectId, input.chatHome);
  await assertSessionFileReadable({
    ...(input.chatHome === undefined ? {} : { chatHome: input.chatHome }),
    sessionPath: info.path,
    sessionId: input.sessionId,
    ...(input.projectId === undefined ? {} : { storageProjectId: input.projectId }),
    requester: input.requester,
  });
}

/** Reads one image only from a concrete tool-result entry in an active Chat Session. */
export async function readChatToolResultImage(
  sessionId: string,
  entryId: string,
  blockIndex: number,
  projectId?: string,
  chatHome?: string,
  requester: import("./long-agents/conversations/access.js").SessionRequester | null = null,
): Promise<ChatToolResultImageRead> {
  const info = await requireChatSession(sessionId, projectId, chatHome);
  // The storage project is always known from the resolved session file, so the topic decision is
  // consulted even when the caller did not pass projectId explicitly.
  const storageProjectId = (info as { projectId?: string }).projectId ?? projectId;
  await assertSessionFileReadable({ ...(chatHome === undefined ? {} : { chatHome }), sessionPath: info.path, sessionId,
    ...(storageProjectId === undefined ? {} : { storageProjectId }), requester });
  let manager: SessionManager;
  try {
    manager = SessionManager.open(info.path, dirname(info.path));
    if (manager.getSessionId() !== sessionId) {
      throw new Error(`Session文件在读取时不可用: ${sessionId}`);
    }
  } catch (error) {
    return rethrowWithCurrentSessionState(info.projectId as string, chatHome, sessionId, error);
  }

  const entry = manager.getEntry(entryId);
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
    return { status: "not-found" };
  }
  const message = entry.message;
  if (message.role !== "toolResult" || !Array.isArray(message.content)) {
    return { status: "not-found" };
  }
  const image = readBase64ToolResultImage(message.content[blockIndex]);
  if (image === null) return { status: "not-found" };
  if (!TOOL_RESULT_IMAGE_MIMES.has(image.mime)) return { status: "unsupported" };
  const bytes = decodeBoundedToolResultImage(image.data);
  if (bytes === null) return { status: "invalid-or-oversized" };
  return { status: "ok", bytes, mime: image.mime };
}

export async function readChatSession(
  sessionId: string,
  leafId?: string | null,
  options: SessionProjectionOptions = {},
  projectId?: string,
  chatHome?: string,
  /**
   * Who is reading. Owner-facing HTTP routes pass `{ kind: "owner" }`; Agent/other callers must
   * declare the Friend they act as. A group participation Session is refused unless the requester is
   * still authorized for it, so ordinary detail/history entries cannot bypass the group projection.
   */
  requester: import("./long-agents/conversations/access.js").SessionRequester | null = null,
) {
  const info = await requireChatSession(sessionId, projectId, chatHome);
  // The storage project is known from the resolved session file, so the topic decision is consulted even
  // when the caller did not pass projectId explicitly.
  const storageProjectId = (info as { projectId?: string }).projectId ?? projectId;
  await assertSessionFileReadable({ ...(chatHome === undefined ? {} : { chatHome }), sessionPath: info.path, sessionId,
    ...(storageProjectId === undefined ? {} : { storageProjectId }), requester });
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
    {
      ...options,
      sessionId: manager.getSessionId(),
      ...(info.projectId === undefined ? {} : { projectId: info.projectId }),
    },
    await resolveChatWorkflowDelegationOrigins(manager),
  );
  const pendingPlanReview = collectPendingPlanReview(entries);
  let activePlanningExecution;
  let activeWorkflowRun;
  let workflowOutcome;
  let workflowCallProjection;
  if (info.projectId !== undefined) {
    const project = await resolveProjectContext(info.projectId, chatHome);
    activeWorkflowRun = await readSessionWorkflowActivity(project, manager.getSessionId());
    if (activeWorkflowRun === undefined) workflowOutcome = await readChatSessionRunOutcome(project.projectDataDir, manager.getSessionId());
    workflowCallProjection = await collectChatWorkflowCallProjection({
      rootSessionId: manager.getSessionId(),
      rootEntries: entries,
      sessionDir: project.sessionDir,
      chatHome: project.chatHome,
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

  // Topic Sessions use the same durable Friend turns, even though the legacy owner index only
  // classifies daily/work Sessions. Restore from the storage scope and actual turn binding; never
  // infer an active execution from the presence of a writer's Workflow stage markers.
  const friendExecution = info.projectId === undefined ? undefined
    : await readSessionFriendExecution(resolveChatHome(chatHome),
      info.owner.type === "long-agent" ? info.owner.longAgentId : info.projectId, sessionId);
  return {
    session: info,
    sessionId: manager.getSessionId(),
    filePath: info.path,
    ...(info.owner.type === "long-agent" || friendExecution !== undefined ? { friendExecution, longAgentActivity: projectLongAgentActivity(entries, info.projectId !== undefined && isChatSessionOperationBusy(info.projectId, manager.getSessionId())) } : {}),
    totalActiveMs: 0,
    tree: manager.getTree(),
    leafId: selectedLeafId ?? null,
    context: {
      messages: context.messages,
      entryIds: context.entryIds,
      entryTimes: context.entryTimes,
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
    ...(activeWorkflowRun === undefined ? {} : { activeWorkflowRun }),
    ...(workflowOutcome === undefined ? {} : { workflowOutcome }),
  };
}

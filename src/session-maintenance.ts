import { join } from "node:path";
import { ModelRuntime, SessionManager, buildSessionContext, estimateTokens, getSessionStats, getSessionContextUsage, type AgentSession, type SessionEntry, type CustomEntry } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "./chat-session.js";
import { createChatPiAgentSession } from "./agents/pi-agent-session.js";
import { CHAT_ASSEMBLY_CONTEXT, readAssemblySnapshot } from "./agents/assembly-context.js";
import { projectAgentSessionEvent } from "./agents/session-events.js";
import { requireChatSession } from "./session-read-model.js";
import { resolveProjectContext } from "./projects/registry.js";
import { assertChatSessionIsIdle } from "./session-activity.js";
import { chatSessionOperationKey, isChatSessionOperationBusy, withChatSessionOperationLock } from "./session-operation-lock.js";
import { SessionInputError, SessionLifecycleError } from "./session-errors.js";
import { readLongAgentRegistry, readLongAgentState } from "./long-agents/storage.js";
import { prepareLongAgentAssembly } from "./long-agents/assembly.js";
import { participationBindingOf } from "./long-agents/conversations/access.js";
import { collectChatWorkflowStageMarkers } from "./workflows/workflow-stage.js";
import { collectLatestChatWorkflowConfigurations } from "./workflows/workflow-configuration.js";
import { getChatWorkflowDefinition } from "./workflows/registry.js";
import { resolveWorkflowAgentDefinition } from "./workflows/agent-config-loader.js";

const OPERATION = "chat.session-maintenance.v1";
export interface SessionMaintenanceInput {
  projectId: string;
  requestId: string;
  expectedLeafId: string | null;
  kind: "compact" | "continue";
  entryId?: string;
  instructions?: string;
}
export interface SessionMaintenanceResult {
  schemaVersion: 1;
  sessionId: string;
  requestId: string;
  kind: "compact" | "continue";
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  error?: string;
  result?: { tokensBefore: number; estimatedTokensAfter: number };
  editorText?: string;
}
interface ActiveOperation {
  result: SessionMaintenanceResult;
  event?: Readonly<Record<string, unknown>>;
  session?: AgentSession;
  cancelled: boolean;
}
const operationsKey = Symbol.for("chat.nativeSessionMaintenance");
const active = ((globalThis as Record<PropertyKey, unknown>)[operationsKey] ??= new Map()) as Map<string, ActiveOperation>;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function parseSessionMaintenanceInput(value: unknown): SessionMaintenanceInput {
  if (!record(value) || Object.keys(value).some(key => !["projectId", "requestId", "expectedLeafId", "kind", "entryId", "instructions"].includes(key))
    || typeof value.projectId !== "string" || !value.projectId
    || typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId)
    || (value.expectedLeafId !== null && (typeof value.expectedLeafId !== "string" || !value.expectedLeafId))
    || (value.kind !== "compact" && value.kind !== "continue")
    || (value.kind === "continue" && (typeof value.entryId !== "string" || !value.entryId || value.instructions !== undefined))
    || (value.kind === "compact" && (value.entryId !== undefined || (value.instructions !== undefined && (typeof value.instructions !== "string" || value.instructions.length > 4000))))) {
    throw new SessionInputError("Invalid session maintenance request");
  }
  return { projectId: value.projectId, requestId: value.requestId, expectedLeafId: value.expectedLeafId as string | null,
    kind: value.kind, ...(typeof value.entryId === "string" ? { entryId: value.entryId } : {}),
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}) };
}

function operationEntries(manager: SessionManager) {
  return manager.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === OPERATION);
}

function storedResult(manager: SessionManager, input?: SessionMaintenanceInput): SessionMaintenanceResult | null {
  const entries = operationEntries(manager);
  const entry = input ? entries.findLast(e => record(e.data) && e.data.requestId === input.requestId) : entries.at(-1);
  if (!entry || !record(entry.data)) return null;
  const data = entry.data;
  if (data.schemaVersion !== 1 || !record(data.input) || !record(data.result)) throw new Error("Invalid native maintenance record");
  if (input && JSON.stringify(data.input) !== JSON.stringify(input)) throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "requestId was already used for a different operation");
  const result = data.result as unknown as SessionMaintenanceResult;
  if (result.sessionId !== manager.getSessionId() || result.requestId !== data.requestId
    || result.schemaVersion !== 1 || result.kind !== data.input.kind || !["compact", "continue"].includes(result.kind)
    || (result.error !== undefined && typeof result.error !== "string") || (result.editorText !== undefined && typeof result.editorText !== "string")
    || (result.result !== undefined && (!record(result.result) || ![result.result.tokensBefore, result.result.estimatedTokensAfter].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)))
    || !["running", "completed", "failed", "cancelled", "interrupted"].includes(result.status)) throw new Error("Invalid maintenance identity");
  if (result.status !== "running") return result;
  const running = active.get(manager.getSessionFile()!);
  if (running?.result.requestId === result.requestId) return running.result;
  // A crash after Pi's native checkpoint but before the receipt is still a proven success.
  const all = manager.getEntries();
  const after = all.slice(all.findIndex(e => e.id === entry.id) + 1);
  const checkpoint = after.find(e => e.type === "compaction" || e.type === "message"
    || (e.type === "custom" && [OPERATION, "chat.workflow_stage"].includes(e.customType)));
  if (result.kind === "compact" && checkpoint?.type === "compaction") {
    return { ...result, status: "completed", result: { tokensBefore: checkpoint.tokensBefore,
      estimatedTokensAfter: buildSessionContext(manager.getEntries(), checkpoint.id).messages.reduce((total, message) => total + estimateTokens(message), 0) } };
  }
  return { ...result, status: "interrupted", error: "Backend interrupted this operation. History was retained; the request will not be replayed." };
}

function lastWorkModel(entries: SessionEntry[]) {
  const stages = new Map(collectChatWorkflowStageMarkers(entries).map(stage => [stage.entryId, stage]));
  let stage;
  let model: { provider: string; modelId: string } | undefined;
  for (const entry of entries) {
    stage = stages.get(entry.id) ?? stage;
    if (entry.type === "message" && entry.message.role === "assistant" && stage?.stageId !== "remember" && stage?.workflowId !== "session-memory") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return model;
}

export async function readSessionMaintenance(projectId: string, sessionId: string, chatHome?: string) {
  const source = await requireChatSession(sessionId, projectId, chatHome);
  const project = await resolveProjectContext(source.projectId!, chatHome);
  const manager = SessionManager.open(source.path, project.sessionDir);
  const context = manager.buildSessionContext();
  const selected = lastWorkModel(manager.getBranch()) ?? context.model;
  const runtime = await ModelRuntime.create({ authPath: join(project.agentDir, "auth.json"), modelsPath: join(project.agentDir, "models.json") });
  const model = selected ? runtime.getModel(selected.provider, selected.modelId) : undefined;
  const stats = getSessionStats(manager, getSessionContextUsage(manager, context.messages, model?.contextWindow ?? 0));
  const { sessionFile: _path, ...safeStats } = stats;
  const writable = !source.readOnly && !source.groupConversation && participationBindingOf(manager.getEntries()) === null;
  return { schemaVersion: 1 as const, sessionId, projectId: project.projectId, leafId: manager.getLeafId(),
    capabilities: { compact: writable, continue: writable && !source.topicNode },
    stats: { ...safeStats, ...(source.name ? { sessionName: source.name } : {}) },
    operation: storedResult(manager), event: active.get(source.path)?.event ?? null };
}

export async function cancelSessionMaintenance(projectId: string, sessionId: string, requestId: string, chatHome?: string) {
  const source = await requireChatSession(sessionId, projectId, chatHome);
  const running = active.get(source.path);
  if (running && running.result.requestId === requestId) {
    running.cancelled = true;
    running.session?.abortCompaction();
  }
  return readSessionMaintenance(projectId, sessionId, chatHome);
}

export async function startSessionMaintenance(sessionId: string, input: SessionMaintenanceInput, chatHome?: string): Promise<SessionMaintenanceResult> {
  input = parseSessionMaintenanceInput(input);
  const source = await requireChatSession(sessionId, input.projectId, chatHome);
  if (source.projectId !== input.projectId || source.readOnly || source.groupConversation || (input.kind === "continue" && source.topicNode)) {
    throw new SessionInputError("This session requires its owner-specific controls");
  }
  const project = await resolveProjectContext(input.projectId, chatHome);
  const native = SessionManager.open(source.path, project.sessionDir);
  if (participationBindingOf(native.getEntries()) !== null) throw new SessionInputError("Group work requires its owner-specific controls");
  const previous = storedResult(native, input);
  if (previous) return previous;
  if (isChatSessionOperationBusy(project.projectId, sessionId)) throw new SessionLifecycleError("SESSION_BUSY", "Session is busy");
  // The HTTP request acknowledges after acceptance is on disk. Only Pi owns the model operation;
  // this adapter holds the same Session lock as starts/removal and never invokes an Agent loop.
  return new Promise((resolve, reject) => {
    let accepted = false;
    void withChatSessionOperationLock(chatSessionOperationKey(project.projectId, sessionId), async () => {
      await assertChatSessionIsIdle(project, sessionId);
      const state = await readLongAgentState(project.chatHome);
      if (state.turns.some(turn => turn.sessionId === sessionId && ["queued", "running"].includes(turn.status))) throw new SessionLifecycleError("SESSION_BUSY", "Session has accepted work");
      const chatSession = await openChatSession({ projectId: project.projectId, chatHome: project.chatHome, sessionId });
      const manager = chatSession.manager;
      const repeated = storedResult(manager, input);
      if (repeated) { resolve(repeated); return; }
      if (manager.getLeafId() !== input.expectedLeafId) throw new SessionLifecycleError("SESSION_STORAGE_CONFLICT", "Session changed; refresh before continuing");
      const result: SessionMaintenanceResult = { schemaVersion: 1, sessionId, requestId: input.requestId, kind: input.kind, status: "running" };
      const persist = () => { manager.appendCustomEntry(OPERATION, { schemaVersion: 1, requestId: input.requestId, input, result: structuredClone(result) }); manager.flush(); };
      if (input.kind === "continue") {
        const target = manager.getEntry(input.entryId!);
        if (target?.type !== "message" || !["user", "assistant"].includes(target.message.role)) throw new SessionInputError("Choose a conversation message");
        if (target.message.role === "assistant" && (target.message.stopReason !== "stop" || target.message.content.some(part => part.type === "toolCall"))) throw new SessionInputError("Choose a completed response, outside a tool call");
        const leaf = target.message.role === "user" ? target.parentId : target.id;
        const boundary = leaf === null ? undefined : buildSessionContext(manager.getEntries(), leaf).messages.findLast(message => message.role === "assistant" || message.role === "toolResult");
        if (boundary && (boundary.role !== "assistant" || boundary.stopReason !== "stop" || boundary.content.some(part => part.type === "toolCall"))) {
          throw new SessionInputError("Choose a completed conversation boundary");
        }
        if (leaf === null) manager.resetLeaf(); else manager.branch(leaf);
        if (target.message.role === "user") result.editorText = typeof target.message.content === "string" ? target.message.content : target.message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        result.status = "completed"; persist(); resolve({ ...result }); return;
      }
      const running: ActiveOperation = { result, cancelled: false };
      persist(); active.set(source.path, running); accepted = true; resolve({ ...result });
      let created: Awaited<ReturnType<typeof createChatPiAgentSession>> | undefined;
      try {
        const branch = manager.getBranch();
        let options;
        if (source.owner.type === "long-agent") {
          const agent = (await readLongAgentRegistry(project.chatHome)).agents.find(item => source.owner.type === "long-agent" && item.id === source.owner.longAgentId);
          if (!agent) throw new Error("Session owner is unavailable");
          const snapshotEntry = branch.findLast(entry => entry.type === "custom" && entry.customType === CHAT_ASSEMBLY_CONTEXT && record(entry.data) && typeof entry.data.turnId === "string");
          const snapshot = snapshotEntry?.type === "custom" && record(snapshotEntry.data) ? readAssemblySnapshot(manager, String(snapshotEntry.data.turnId)) : undefined;
          options = await prepareLongAgentAssembly({ agent, chatHome: project.chatHome, projectId: snapshot?.projectId ?? null, turnId: `compact:${input.requestId}` });
        } else {
          const stage = collectChatWorkflowStageMarkers(branch).findLast(item => item.nodeKind === "agent" && item.stageId !== "remember" && item.workflowId !== "session-memory");
          const workflow = getChatWorkflowDefinition(stage?.workflowId ?? "minimal-pi-coding-agent");
          const definition = workflow?.agents.find(item => item.id === stage?.agentId) ?? workflow?.agents[0];
          if (!definition || !workflow) throw new Error("Session agent is unavailable");
          const selection = collectLatestChatWorkflowConfigurations(branch)[workflow.id]?.[definition.id];
          options = { agent: await resolveWorkflowAgentDefinition({ defaultAgent: definition, cwd: chatSession.cwd, chatHome: project.chatHome,
            durableModelConfig: { projectDataDir: project.projectDataDir, workflowId: workflow.id, agentId: definition.id },
            ...(selection ? { selection } : {}) }) };
        }
        const previousModel = lastWorkModel(branch);
        if (source.owner.type === "ordinary" && options.agent.model === undefined && previousModel) {
          options = { ...options, agent: { ...options.agent, model: previousModel } };
        }
        created = await createChatPiAgentSession({ chatSession, sessionManager: manager, ...options,
          // Native compact uses summary generation, never an Agent tool loop. Keep resource and
          // extension hooks, but do not manufacture a Workflow invocation to bind executable tools.
          agent: { ...options.agent, tools: { mode: "none" } },
          toolContext: { purpose: "execution", agentId: options.agent.id,
            ...(source.owner.type === "long-agent" ? { longAgentId: source.owner.longAgentId, longAgentTurnId: `compact:${input.requestId}` } : {}) } });
        running.session = created.session;
        created.session.subscribe(event => {
          const projected = projectAgentSessionEvent(event);
          if (projected) running.event = projected;
          if (event.type === "compaction_end" && event.aborted) running.cancelled = true;
          if (event.type === "compaction_start" && running.cancelled) created?.session.abortCompaction();
        });
        if (running.cancelled) throw new Error("Compaction cancelled");
        const compacted = await created.session.compact(input.instructions);
        result.status = "completed";
        result.result = { tokensBefore: compacted.tokensBefore, estimatedTokensAfter: compacted.estimatedTokensAfter! };
      } catch (error) {
        result.status = running.cancelled ? "cancelled" : "failed";
        if (!running.cancelled) result.error = error instanceof Error ? error.message : String(error);
      } finally {
        try { persist(); } finally { created?.session.dispose(); active.delete(source.path); }
      }
    }, source.owner.type === "long-agent" ? { longAgentId: source.owner.longAgentId } : undefined).catch(error => {
      reject(error);
      // After acceptance, the HTTP promise is already settled. Keep persistence failures visible
      // in diagnostics; a later read derives interrupted/completed from the native file.
      if (accepted) console.error("[session-maintenance] Could not persist native maintenance result", error);
      if (active.get(source.path)?.result.requestId === input.requestId) active.delete(source.path);
    });
  });
}

import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { DAILY_PROJECT_ID } from "../projects/registry.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";
import { readBase64ToolResultImage } from "../session-tool-result-images.js";
import {
  collectChatLongAgentTurnMarkers,
} from "./session-turn.js";
import {
  acknowledgeNanoClawInbound,
  checkNanoClawGateway,
  persistNanoClawDelivery,
} from "./nanoclaw-client.js";
import { ensureProjectLongAgent } from "./project-agent.js";
import { publicLongAgentAvatar } from "./configuration.js";
import { executeLongAgentTurn } from "./runtime.js";
import { readLongAgentRegistry, readLongAgentState, updateLongAgentState } from "./storage.js";
import type {
  LongAgentAddress,
  LongAgentConfig,
  LongAgentConversationBinding,
  LongAgentInstanceConfig,
  LongAgentPendingEvent,
  LongAgentRegistry,
  LongAgentState,
  NanoClawIntegrationEvent,
  ProjectLongAgent,
} from "./types.js";

const MAX_TURN_DELIVERY_IMAGES = 10;

const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** One image attachment in the NanoClaw Delivery envelope (base64 payload). */
export interface TurnDeliveryImage {
  readonly filename: string;
  readonly data: string;
}

/**
 * Collects image blocks produced during one completed Turn (Tool results are
 * the only Pi message role that carries images) so they can ride the NanoClaw
 * Delivery envelope and reach the channel as real image messages.
 */
async function collectTurnDeliveryImages(
  chatHome: string,
  projectId: string,
  sessionId: string,
  turnId: string,
): Promise<TurnDeliveryImage[]> {
  const chatSession = await openChatSession({ projectId, chatHome, sessionId });
  const entries = chatSession.manager.getBranch();
  const markers = collectChatLongAgentTurnMarkers(entries).filter((marker) => marker.turnId === turnId);
  const start = markers.find((marker) => marker.status === "running");
  const end = markers.findLast((marker) => marker.status === "completed");
  if (start === undefined || end === undefined) return [];
  const startIndex = entries.findIndex(
    (entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === start.entryId,
  );
  const endIndex = entries.findIndex(
    (entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === end.entryId,
  );
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return [];
  const images: TurnDeliveryImage[] = [];
  for (let index = startIndex + 1; index < endIndex && images.length < MAX_TURN_DELIVERY_IMAGES; index += 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || !("message" in entry)) continue;
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) continue;
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "toolResult" || !Array.isArray(record.content)) continue;
    for (const block of record.content) {
      const image = readBase64ToolResultImage(block);
      if (image === null || images.length >= MAX_TURN_DELIVERY_IMAGES) continue;
      const extension = IMAGE_MIME_TO_EXTENSION[image.mime] ?? "png";
      images.push({ filename: `image-${String(images.length + 1)}.${extension}`, data: image.data });
    }
  }
  return images;
}

export const LONG_AGENT_MESSAGE_SOURCE = "chat.long_agent";
const PUBLIC_CHANNEL_GATEWAY_ERROR = "NanoClaw Channel Gateway不可用";

interface LongAgentMessageProvenance {
  readonly source: typeof LONG_AGENT_MESSAGE_SOURCE;
  readonly eventId: string;
  readonly messageId: string;
  readonly longAgentId: string;
  readonly nanoclawSessionId: string;
  readonly direction: "in" | "out";
  readonly channelType: string | null;
}

type LongAgentUserMessage = UserMessage & { readonly chatLongAgent: LongAgentMessageProvenance };
type LongAgentAssistantMessage = AssistantMessage & { readonly chatLongAgent: LongAgentMessageProvenance };

export interface LongAgentSyncResult {
  readonly instanceId: string;
  readonly status: "ok" | "unavailable";
  readonly pulled: number;
  readonly projected: number;
  readonly executed: number;
  readonly cursor: number;
  readonly error?: string;
}

export interface LongAgentEventAcceptance {
  readonly schemaVersion: 1;
  readonly results: readonly {
    readonly eventId: string;
    readonly status: "accepted" | "duplicate";
  }[];
}

export class LongAgentEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LongAgentEventConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventPayloadHash(event: NanoClawIntegrationEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function instanceFor(registry: LongAgentRegistry, id: string): LongAgentInstanceConfig {
  const instance = registry.instances.find((candidate) => candidate.id === id);
  if (instance === undefined) throw new Error(`找不到LongAgent instance: ${id}`);
  return instance;
}

function agentForEvent(
  registry: LongAgentRegistry,
  instanceId: string,
  event: NanoClawIntegrationEvent,
): LongAgentConfig | undefined {
  return registry.agents.find((agent) => agent.enabled
    && agent.instanceId === instanceId
    && agent.nanoclawAgentGroupId === event.agentGroupId);
}

function sameAddress(left: LongAgentAddress, right: LongAgentAddress): boolean {
  return left.channelType === right.channelType
    && left.instance === right.instance
    && left.platformId === right.platformId
    && left.threadId === right.threadId;
}

function eventSource(event: NanoClawIntegrationEvent): LongAgentAddress | null {
  return event.direction === "in" ? event.source : event.delivery ?? event.source;
}

function findBinding(
  state: LongAgentState,
  agent: LongAgentConfig,
  event: NanoClawIntegrationEvent,
): LongAgentConversationBinding | undefined {
  if (event.chatSessionId !== null) {
    const projectAgent = state.projectAgents.find((candidate) => candidate.primarySessionId === event.chatSessionId
      && candidate.longAgentId === agent.id);
    const direct = projectAgent === undefined
      ? undefined
      : state.bindings.find((binding) => binding.projectLongAgentId === projectAgent.id);
    if (direct !== undefined) return direct;
  }
  const byNanoSession = state.bindings.find((binding) => binding.nanoclawInstanceId === agent.instanceId
    && binding.nanoclawSessionId === event.nanoSessionId);
  if (byNanoSession !== undefined) return byNanoSession;
  const source = eventSource(event);
  if (source === null) return undefined;
  const projectAgentIds = new Set(state.projectAgents
    .filter((candidate) => candidate.longAgentId === agent.id)
    .map((candidate) => candidate.id));
  return state.bindings.find((binding) => projectAgentIds.has(binding.projectLongAgentId) && sameAddress(binding.source, source));
}

function withUpdatedBinding(
  state: LongAgentState,
  binding: LongAgentConversationBinding,
): LongAgentState {
  return {
    ...state,
    bindings: state.bindings.map((candidate) => candidate.id === binding.id ? binding : candidate),
  };
}

async function ensureEventBinding(
  chatHome: string,
  agent: LongAgentConfig,
  event: NanoClawIntegrationEvent,
): Promise<{ readonly binding: LongAgentConversationBinding; readonly projectAgent: ProjectLongAgent } | undefined> {
  const ensured = event.direction === "in" && event.source !== null && !event.isGroup
    ? await ensureProjectLongAgent({
        chatHome,
        projectId: agent.defaultProjectId,
        agent,
      })
    : undefined;
  return updateLongAgentState(chatHome, async (state) => {
    const existing = findBinding(state, agent, event);
    if (existing !== undefined) {
      const updated = existing.nanoclawSessionId === event.nanoSessionId
        ? existing
        : { ...existing, nanoclawSessionId: event.nanoSessionId, updatedAt: new Date().toISOString() };
      return {
        state: updated === existing ? state : withUpdatedBinding(state, updated),
        result: {
          binding: updated,
          projectAgent: state.projectAgents.find((candidate) => candidate.id === updated.projectLongAgentId) as ProjectLongAgent,
        },
      };
    }
    if (event.direction !== "in" || event.source === null || event.isGroup) {
      return { state, result: undefined };
    }
    if (ensured === undefined) return { state, result: undefined };
    const now = new Date().toISOString();
    const binding: LongAgentConversationBinding = {
      id: randomUUID(),
      projectLongAgentId: ensured.projectAgent.id,
      nanoclawInstanceId: agent.instanceId,
      nanoclawAgentGroupId: agent.nanoclawAgentGroupId,
      nanoclawSessionId: event.nanoSessionId,
      primaryMessagingGroupId: event.messagingGroupId,
      source: event.source,
      createdAt: now,
      updatedAt: now,
    };
    return {
      state: { ...state, bindings: [...state.bindings, binding] },
      result: { binding, projectAgent: ensured.projectAgent },
    };
  });
}

function entryHasEvent(entry: SessionEntry, eventId: string): boolean {
  return entry.type === "message"
    && isRecord(entry.message)
    && isRecord(entry.message.chatLongAgent)
    && entry.message.chatLongAgent.source === LONG_AGENT_MESSAGE_SOURCE
    && entry.message.chatLongAgent.eventId === eventId;
}

function provenance(
  binding: LongAgentConversationBinding,
  projectAgent: ProjectLongAgent,
  event: NanoClawIntegrationEvent,
): LongAgentMessageProvenance {
  return {
    source: LONG_AGENT_MESSAGE_SOURCE,
    eventId: event.eventId,
    messageId: event.messageId,
    longAgentId: projectAgent.longAgentId,
    nanoclawSessionId: event.nanoSessionId,
    direction: event.direction,
    channelType: (event.direction === "in" ? event.source : event.delivery)?.channelType ?? null,
  };
}

async function projectEvent(
  chatHome: string,
  binding: LongAgentConversationBinding,
  projectAgent: ProjectLongAgent,
  event: NanoClawIntegrationEvent,
): Promise<boolean> {
  if (event.kind !== "chat" || (event.text.trim() === "" && (event.images?.length ?? 0) === 0)) return false;
  return withChatSessionOperationLock(
    chatSessionOperationKey(projectAgent.projectId, projectAgent.primarySessionId),
    async () => {
      const session = await openChatSession({
        projectId: projectAgent.projectId,
        chatHome,
        sessionId: projectAgent.primarySessionId,
      });
      if (session.manager.getEntries().some((entry) => entryHasEvent(entry, event.eventId))) return false;
      const timestamp = Date.parse(event.timestamp);
      if (event.direction === "in") {
        const message: LongAgentUserMessage = {
          role: "user",
          content: [{ type: "text", text: event.text }, ...(event.images ?? [])],
          timestamp,
          chatLongAgent: provenance(binding, projectAgent, event),
        };
        session.manager.appendMessage(message);
      } else {
        const message: LongAgentAssistantMessage = {
          role: "assistant",
          api: "nanoclaw",
          provider: "nanoclaw",
          model: projectAgent.longAgentId,
          content: [{ type: "text", text: event.text }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp,
          chatLongAgent: provenance(binding, projectAgent, event),
        };
        session.manager.appendMessage(message);
      }
      session.manager.flush();
      return true;
    },
  );
}

async function syncInstance(
  chatHome: string,
  registry: LongAgentRegistry,
  instance: LongAgentInstanceConfig,
  pendingEvents: readonly LongAgentPendingEvent[],
): Promise<LongAgentSyncResult> {
  let cursor = 0;
  let projected = 0;
  let executed = 0;
  let firstError: string | undefined;
  for (const pending of pendingEvents) {
    const event = pending.event;
    try {
      const agent = agentForEvent(registry, instance.id, event);
      if (agent === undefined) throw new Error(`NanoClaw事件没有可用Long Agent映射: ${event.agentGroupId}`);
      const resolved = await ensureEventBinding(chatHome, agent, event);
      if (event.direction === "in" && resolved === undefined) {
        throw new Error(`LongAgent入站事件尚未绑定Project会话: ${event.eventId}`);
      }
      if (resolved !== undefined && event.direction === "in") {
        const destination = event.delivery ?? event.source;
        if (destination === null) throw new Error(`LongAgent事件缺少回复地址: ${event.eventId}`);
        const result = await executeLongAgentTurn({
          longAgentId: agent.id,
          projectId: resolved.projectAgent.projectId,
          sessionId: resolved.projectAgent.primarySessionId,
          text: event.text,
          ...(event.images === undefined ? {} : { images: event.images }),
          chatHome,
          turnId: event.eventId,
          inboundEventId: event.eventId,
          source: "channel",
          channelType: event.source?.channelType ?? destination.channelType,
        });
        const deliveryId = `chat-pi:${result.turnId}`;
        const files = await collectTurnDeliveryImages(
          chatHome,
          resolved.projectAgent.projectId,
          resolved.projectAgent.primarySessionId,
          result.turnId,
        );
        await persistNanoClawDelivery({
          instance,
          agentGroupId: agent.nanoclawAgentGroupId,
          nanoSessionId: event.nanoSessionId,
          messageId: deliveryId,
          chatSessionId: resolved.projectAgent.primarySessionId,
          destination,
          text: result.text,
          ...(files.length === 0 ? {} : { files }),
        });
        await acknowledgeNanoClawInbound({
          instance,
          agentGroupId: agent.nanoclawAgentGroupId,
          nanoSessionId: event.nanoSessionId,
          messageId: event.messageId,
        });
        executed += 1;
      } else if (!(event.direction === "out" && event.messageId.startsWith("chat-pi:"))
        && resolved !== undefined && await projectEvent(chatHome, resolved.binding, resolved.projectAgent, event)) {
        projected += 1;
      }
      await updateLongAgentState(chatHome, (state) => ({
        state: {
          ...state,
          pendingEvents: state.pendingEvents.filter((candidate) => candidate.event.eventId !== event.eventId),
          processedEvents: [
            ...state.processedEvents.filter((candidate) => candidate.eventId !== event.eventId),
            { eventId: event.eventId, payloadHash: eventPayloadHash(event), processedAt: new Date().toISOString() },
          ].slice(-10_000),
        },
        result: undefined,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      firstError ??= message;
      await updateLongAgentState(chatHome, (state) => ({
        state: {
          ...state,
          pendingEvents: state.pendingEvents.map((candidate) => {
            if (candidate.event.eventId !== event.eventId) return candidate;
            const attempts = candidate.attempts + 1;
            const delayMs = Math.min(60_000, 1000 * (2 ** Math.min(attempts - 1, 6)));
            return {
              ...candidate,
              attempts,
              nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
              lastError: message.slice(0, 2000),
            };
          }),
        },
        result: undefined,
      }));
    }
    cursor = Math.max(cursor, event.seq);
  }
  return {
    instanceId: instance.id,
    status: firstError === undefined ? "ok" : "unavailable",
    pulled: pendingEvents.length,
    projected,
    executed,
    cursor,
    ...(firstError === undefined ? {} : { error: firstError }),
  };
}

async function performLongAgentSync(
  chatHome = resolveChatHome(),
): Promise<LongAgentSyncResult[]> {
  const registry = await readLongAgentRegistry(chatHome);
  const state = await readLongAgentState(chatHome);
  const activeInstanceIds = new Set(registry.agents.filter((agent) => agent.enabled).map((agent) => agent.instanceId));
  const results: LongAgentSyncResult[] = [];
  for (const instance of registry.instances.filter((candidate) => activeInstanceIds.has(candidate.id))) {
    try {
      results.push(await syncInstance(
        chatHome,
        registry,
        instance,
        state.pendingEvents.filter((pending) => (
          pending.event.instanceId === instance.id && Date.parse(pending.nextAttemptAt) <= Date.now()
        )),
      ));
    } catch (error) {
      results.push({
        instanceId: instance.id,
        status: "unavailable",
        pulled: 0,
        projected: 0,
        executed: 0,
        cursor: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Durably accepts NanoClaw events before returning HTTP 202. */
export async function acceptLongAgentEvents(input: {
  readonly instanceId: string;
  readonly events: readonly NanoClawIntegrationEvent[];
  readonly chatHome?: string;
}): Promise<LongAgentEventAcceptance> {
  const chatHome = resolveChatHome(input.chatHome);
  const registry = await readLongAgentRegistry(chatHome);
  if (!registry.instances.some((instance) => instance.id === input.instanceId)) {
    throw new Error(`未知NanoClaw instance: ${input.instanceId}`);
  }
  for (const event of input.events) {
    if (event.instanceId !== input.instanceId) throw new Error(`NanoClaw事件instance不匹配: ${event.eventId}`);
    if (agentForEvent(registry, input.instanceId, event) === undefined) {
      throw new Error(`NanoClaw路由未映射到Chat Long Agent: ${event.agentGroupId}`);
    }
  }
  const results = await updateLongAgentState(chatHome, (state) => {
    const byId = new Map(state.pendingEvents.map((pending) => [pending.event.eventId, pending]));
    const processedById = new Map(state.processedEvents.map((processed) => [processed.eventId, processed]));
    const results: Array<{ eventId: string; status: "accepted" | "duplicate" }> = [];
    for (const event of input.events) {
      const existing = byId.get(event.eventId);
      const processed = processedById.get(event.eventId);
      if (existing !== undefined && JSON.stringify(existing.event) !== JSON.stringify(event)) {
        throw new LongAgentEventConflictError(`NanoClaw事件幂等冲突: ${event.eventId}`);
      }
      if (processed !== undefined && processed.payloadHash !== eventPayloadHash(event)) {
        throw new LongAgentEventConflictError(`NanoClaw事件幂等冲突: ${event.eventId}`);
      }
      results.push({
        eventId: event.eventId,
        status: existing === undefined && processed === undefined ? "accepted" : "duplicate",
      });
      if (processed !== undefined) continue;
      byId.set(event.eventId, existing ?? {
        event,
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        lastError: null,
      });
    }
    return { state: { ...state, pendingEvents: [...byId.values()] }, result: results };
  });
  void syncLongAgentEvents(chatHome).catch((error: unknown) => {
    console.error(`LongAgent Channel事件执行失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { schemaVersion: 1, results };
}

const syncs = new Map<string, Promise<LongAgentSyncResult[]>>();

/** Coalesces HTTP ingress and recovery retries for one Chat Home. */
export function syncLongAgentEvents(chatHome = resolveChatHome()): Promise<LongAgentSyncResult[]> {
  const root = resolveChatHome(chatHome);
  const existing = syncs.get(root);
  if (existing !== undefined) return existing;
  const running = performLongAgentSync(root).finally(() => {
    if (syncs.get(root) === running) syncs.delete(root);
  });
  syncs.set(root, running);
  return running;
}

const syncTimers = new Map<string, NodeJS.Timeout>();
const reportedSyncErrors = new Map<string, string>();

/** Retries Chat-owned durable Channel events after Backend restarts or transient failures. */
export function startLongAgentSync(chatHome = resolveChatHome(), intervalMs = 2_000): void {
  const root = resolveChatHome(chatHome);
  if (syncTimers.has(root)) return;
  const run = () => {
    void syncLongAgentEvents(root).then((results) => {
      for (const result of results) {
        const errorKey = `${root}\0${result.instanceId}`;
        if (result.status === "unavailable") {
          const message = result.error ?? "unknown error";
          if (reportedSyncErrors.get(errorKey) !== message) {
            reportedSyncErrors.set(errorKey, message);
            console.error(`LongAgent ${result.instanceId}同步不可用: ${message}`);
          }
        } else {
          reportedSyncErrors.delete(errorKey);
        }
      }
    }).catch((error: unknown) => {
      console.error(`LongAgent后台同步失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  syncTimers.set(root, timer);
}

export async function listLongAgents(input: {
  readonly projectId?: string;
  readonly chatHome?: string;
} = {}) {
  const chatHome = resolveChatHome(input.chatHome);
  const [registry, state] = await Promise.all([
    readLongAgentRegistry(chatHome),
    readLongAgentState(chatHome),
  ]);
  const gatewayAvailability = new Map(await Promise.all(registry.instances.map(async (instance) => (
    [instance.id, await checkNanoClawGateway(instance)] as const
  ))));
  const refreshedState = state;
  const health = new Map(registry.instances.map((instance) => {
    const pending = state.pendingEvents.filter((candidate) => candidate.event.instanceId === instance.id);
    const failed = pending.find((candidate) => candidate.lastError !== null);
    return [instance.id, {
      instanceId: instance.id,
      status: failed === undefined ? "ok" as const : "unavailable" as const,
      pulled: pending.length,
      projected: 0,
      executed: 0,
      cursor: 0,
      ...(failed?.lastError === null || failed === undefined ? {} : { error: failed.lastError }),
    }];
  }));
  return {
    agents: await Promise.all(registry.agents.map(async (agent) => {
      const instance = instanceFor(registry, agent.instanceId);
      const result = health.get(instance.id);
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        avatar: publicLongAgentAvatar(agent.avatar),
        defaultProjectId: agent.defaultProjectId,
        status: agent.status,
        runtime: "pi" as const,
        configuration: {
          model: agent.definition.model ?? null,
          thinkingLevel: agent.definition.thinkingLevel ?? null,
          toolMode: agent.definition.tools.mode,
          channelType: agent.inbox?.channelType ?? null,
        },
        project: input.projectId === undefined
          ? null
          : (() => {
              // 共享 daily 视图下，已迁移 Agent 展示自己 Daily Project 的当前会话，
              // 而不是迁移前的旧共享绑定。
              const effectiveProjectId = input.projectId === DAILY_PROJECT_ID
                && agent.defaultProjectId !== DAILY_PROJECT_ID
                ? agent.defaultProjectId
                : input.projectId;
              const projectAgent = refreshedState.projectAgents.find((candidate) => candidate.projectId === effectiveProjectId
                && candidate.longAgentId === agent.id);
              return projectAgent === undefined
                ? { started: false as const, status: null, projectLongAgentId: null, primarySessionId: null }
                : {
                    started: true as const,
                    status: projectAgent.status,
                    projectLongAgentId: projectAgent.id,
                    primarySessionId: projectAgent.primarySessionId,
                  };
            })(),
        // Chat Web runs the Long Agent through Chat's Pi runtime. NanoClaw
        // channel health is reported separately and must not disable Web use.
        available: agent.enabled,
        channelHostAvailable: gatewayAvailability.get(instance.id) ?? false,
        syncStatus: result?.status ?? "unavailable",
        ...(result?.error === undefined ? {} : { syncError: PUBLIC_CHANNEL_GATEWAY_ERROR }),
      };
    })),
    bindings: refreshedState.bindings
      .flatMap((binding) => {
        const projectAgent = refreshedState.projectAgents.find((candidate) => candidate.id === binding.projectLongAgentId);
        if (projectAgent === undefined || (input.projectId !== undefined && projectAgent.projectId !== input.projectId)) return [];
        return [{
          id: binding.id,
          projectLongAgentId: projectAgent.id,
          projectId: projectAgent.projectId,
          chatSessionId: projectAgent.primarySessionId,
          longAgentId: projectAgent.longAgentId,
          channelType: binding.source.channelType,
          nanoclawSessionId: binding.nanoclawSessionId,
        }];
      }),
    sync: [...health.values()].map((result) => ({
      ...result,
      ...(result.error === undefined ? {} : { error: PUBLIC_CHANNEL_GATEWAY_ERROR }),
    })),
  };
}

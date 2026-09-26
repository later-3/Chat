import { registerLiveTurn } from "./live-turn.js";
import { projectSessionContext } from "../session-read-model.js";
import type { WorkflowAgentDefinition } from "../workflows/agent-config.js";
import type { LongAgentConfig } from "./types.js";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AcceptedTurn } from "./daily-state.js";
import { executeQueuedLongAgentTurn, installAcceptedAssembly } from "./turn-queue.js";
import { randomUUID } from "node:crypto";
import { prepareLongAgentAssembly } from "./assembly.js";
import { readAssemblySnapshot } from "../agents/assembly-context.js";
import type { AssistantMessage, ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { createChatPiAgentSession } from "../agents/pi-agent-session.js";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";
import { assertModelSupportsImages } from "../workflows/image-input.js";
import { readLongAgentState, readLongAgentRegistry } from "./storage.js";
import { openAcceptedDay } from "./project-agent.js";
import {
  appendChatLongAgentTurn,
  collectChatLongAgentTurnMarkers,
  findChatLongAgentTurnResumeEntryId,
  latestChatLongAgentTurn,
  type ChatLongAgentTurnSource,
} from "./session-turn.js";
import {
  agentGroupContextRevisionOf,
  readFrozenLongAgentAgentGroup,
} from "./agent-group-service.js";

const CHAT_WEB_CHANNEL = "chat-web";
const MAX_LONG_AGENT_MESSAGE_CHARS = 100_000;

export interface ExecuteLongAgentTurnInput {
  readonly longAgentId: string;
  readonly projectId: string;
  readonly sessionId?: string;
  /**
   * Topic node target for an owner-confirmed node round. Verified against the topic graph at
   * acceptance; the turn is then bound to the matching node session (never to an arbitrary session).
   */
  readonly topicNode?: { readonly topicId: string; readonly nodeId: string };
  /**
   * Relay round: the durable relay INTENT to consume. Verified at acceptance (node session, intent for
   * this node) and appended as a native user message on the active branch when the round runs.
   */
  readonly relayIntentEntryId?: string;
  /** Send-time switch: "off" runs this round WITHOUT the session-memory tail node. */
  readonly sessionMemory?: "off";
  readonly text: unknown;
  /** Channel-provided image attachments; text may be empty when present. */
  readonly images?: readonly ImageContent[];
  readonly chatHome?: string;
  /** Stable external idempotency key. Chat Web omits this and receives a new Turn ID. */
  readonly turnId?: string;
  readonly inboundEventId?: string;
  readonly source?: ChatLongAgentTurnSource;
  readonly channelType?: string | null;
  /** 本轮协作目标；null/省略均无项目，渠道适配器须显式提供绑定目标。 */
  readonly contextProjectId?: string | null;
  /**
   * Revision of the Friend's collaboration-project association that the caller last read. Declared by
   * the owner-facing private-chat entry: acceptance then resolves and freezes the project from the
   * association (never from an arbitrary per-turn projectId) and rejects a stale revision.
   */
  readonly interactionRevision?: number;
  /**
   * Set by the owner-facing HTTP private-chat entries: an ordinary private turn must then carry
   * `interactionRevision` and may not fall back to a bare `contextProjectId`. Internal callers and
   * accepted-turn recovery keep the legacy seam; a server-derived work-session target is exempt.
   */
  readonly requireInteractionRevision?: boolean;
  /** Trusted Nano daily-summary trigger; read-only draft, never final coverage. */
  readonly summaryDraft?: boolean;
}

export interface ExecuteLongAgentTurnResult {
  readonly accepted: true;
  readonly completed: true;
  readonly sessionId: string;
  readonly projectLongAgentId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly isNewSession: boolean;
  readonly text: string;
  readonly model: { readonly provider: string; readonly modelId: string } | null;
}

function parseText(value: unknown, hasImages: boolean): string {
  // Channel image-only messages arrive without a text caption.
  if (typeof value !== "string" || (value.trim() === "" && !hasImages)) {
    throw new Error("text必须是非空字符串");
  }
  if (value.length > MAX_LONG_AGENT_MESSAGE_CHARS) {
    throw new Error(`text不能超过${String(MAX_LONG_AGENT_MESSAGE_CHARS)}个字符`);
  }
  return value;
}

function nonEmpty(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") throw new Error(`${field}必须是非空字符串`);
  return value;
}

/** Chat-owned default definition used until a Long Agent has explicit overrides. */
export function createLongAgentDefinition(agent: LongAgentConfig): WorkflowAgentDefinition {
  return agent.definition;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
}

function assistantBetween(
  entries: readonly unknown[],
  startEntryId: string,
  endEntryId?: string,
): AssistantMessage | undefined {
  const start = entries.findIndex((entry) => (
    typeof entry === "object" && entry !== null && "id" in entry && entry.id === startEntryId
  ));
  if (start < 0) return undefined;
  const end = endEntryId === undefined
    ? entries.length
    : entries.findIndex((entry) => (
        typeof entry === "object" && entry !== null && "id" in entry && entry.id === endEntryId
      ));
  if (end < 0) return undefined;
  for (let index = end - 1; index > start; index -= 1) {
    const entry = entries[index];
    if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message"
      || !("message" in entry) || typeof entry.message !== "object" || entry.message === null
      || !("role" in entry.message) || entry.message.role !== "assistant") continue;
    return entry.message as AssistantMessage;
  }
  return undefined;
}

/** All entry points use durable acceptance before the native runtime. */
export const executeLongAgentTurn = executeQueuedLongAgentTurn;

/** Internal worker: the accepted day is immutable, including after midnight. */
export async function executeAcceptedLongAgentTurn(
  input: ExecuteLongAgentTurnInput,
  accepted: AcceptedTurn,
  preparedResourceLoader?: DefaultResourceLoader,
): Promise<ExecuteLongAgentTurnResult> {
  const chatHome = resolveChatHome(input.chatHome);
  const images = input.images === undefined || input.images.length === 0 ? undefined : input.images;
  const text = parseText(input.text, images !== undefined);
  const turnId = nonEmpty(input.turnId, "turnId") ?? randomUUID();
  const inboundEventId = nonEmpty(input.inboundEventId, "inboundEventId") ?? null;
  const registry = await readLongAgentRegistry(chatHome);
  const agent = registry.agents.find((candidate) => ((candidate.enabled && candidate.status !== "archived") || accepted.status === "completed") && candidate.id === input.longAgentId);
  if (agent === undefined) throw new Error(`找不到可用LongAgent: ${input.longAgentId}`);
  await resolveProjectContext(input.projectId, chatHome);
  const work = accepted.workId === undefined ? undefined : (await readLongAgentState(chatHome)).works.find(w =>
    w.id === accepted.workId && w.longAgentId === agent.id && w.sessionId === accepted.sessionId);
  if (accepted.workId !== undefined && !work) throw new Error("后台工作执行绑定无效");
  const projectAgent = work ? { id: work.id, projectId: agent.id, primarySessionId: work.sessionId }
    : await openAcceptedDay(chatHome, agent.id, accepted.sessionId);
  const isNewSession = accepted.isNewSession;
  const source = input.source ?? "chat-web";
  const channelType = input.channelType === undefined
    ? (source === "chat-web" ? CHAT_WEB_CHANNEL : null)
    : input.channelType;

  return withChatSessionOperationLock(
    chatSessionOperationKey(projectAgent.projectId, projectAgent.primarySessionId),
    async () => {
      const chatSession = await openChatSession({
        projectId: projectAgent.projectId,
        chatHome,
        sessionId: projectAgent.primarySessionId,
      });
      if (accepted.status !== "completed" && accepted.relayIntentEntryId !== undefined) {
        // Append the relayed native user message ON THE ACTIVE BRANCH when the round runs. N queued
        // relays therefore become N sequential rounds with exactly ONE message per request; the message
        // is appended before the assembly so it stays the last real message the round continues from.
        const { appendRelayedTopicNodeMessage } = await import("./topics.js");
        appendRelayedTopicNodeMessage(chatSession.manager, accepted.relayIntentEntryId);
      }
      if (accepted.status !== "completed") installAcceptedAssembly(chatSession.manager, accepted, { skipCollaborationHistory: accepted.relayIntentEntryId !== undefined });
      const entriesBeforeRun = chatSession.manager.getBranch();
      const previous = latestChatLongAgentTurn(entriesBeforeRun, turnId);
      const turnMarkers = collectChatLongAgentTurnMarkers(entriesBeforeRun)
        .filter((marker) => marker.turnId === turnId);
      const started = previous?.status === "running"
        ? previous
        : turnMarkers.slice(0, -1).findLast((marker) => marker.status === "running");

      let startedAt = previous?.status === "running"
        ? previous.startedAt
        : new Date().toISOString();
      let resumePending = false;
      let resumeEntryId: string | undefined;
      let recoveredAssistant: AssistantMessage | undefined;
      if (previous?.status === "completed") {
        recoveredAssistant = started === undefined
          ? undefined
          : assistantBetween(entriesBeforeRun, started.entryId, previous.entryId);
      } else if (previous?.status === "running") {
        recoveredAssistant = assistantBetween(entriesBeforeRun, previous.entryId);
        if (recoveredAssistant?.stopReason !== "stop") recoveredAssistant = undefined;
        if (recoveredAssistant === undefined) {
          const messages = chatSession.manager.buildSessionContext().messages;
          const role = messages.at(-1)?.role;
          resumePending = role === "user" || role === "toolResult";
        }
      } else {
        if (previous?.status === "failed" && started !== undefined) {
          resumeEntryId = findChatLongAgentTurnResumeEntryId(
            entriesBeforeRun,
            started.entryId,
            previous.entryId,
          );
          startedAt = new Date().toISOString();
        }
      }

      if (previous?.status === "completed") {
        if (recoveredAssistant === undefined) {
          throw new Error(`Long Agent Turn ${turnId}已完成但缺少Assistant消息`);
        }
        return {
          accepted: true,
          completed: true,
          sessionId: projectAgent.primarySessionId,
          projectLongAgentId: projectAgent.id,
          messageId: turnId,
          turnId,
          isNewSession,
          text: assistantText(recoveredAssistant),
          model: {
            provider: recoveredAssistant.provider,
            modelId: recoveredAssistant.model,
          },
        };
      }

      const groupContext = await readFrozenLongAgentAgentGroup(agent.id, accepted.groupContext, chatHome);
      const agentGroupContext = agentGroupContextRevisionOf(groupContext);
      // A relay round consumes the user message the round just appended; never prompt a second copy.
      if (accepted.relayIntentEntryId !== undefined) resumePending = true;
      if (resumeEntryId !== undefined) {
        chatSession.manager.branch(resumeEntryId);
        resumePending = true;
      }
      if (previous?.status !== "running") {
        appendChatLongAgentTurn(chatSession.manager, {
          turnId,
          longAgentId: agent.id,
          bindingId: projectAgent.id,
          source,
          channelType,
          inboundEventId,
          agentGroupContext,
          status: "running",
          startedAt,
          completedAt: null,
          error: null,
        });
        chatSession.manager.flush();
      }

      let created: Awaited<ReturnType<typeof createChatPiAgentSession>> | undefined;
      let lastAssistant = recoveredAssistant;
      try {
        const frozen = readAssemblySnapshot(chatSession.manager, turnId);
        const prepared = await prepareLongAgentAssembly({
          agent, chatHome, turnId, groupContext, today: accepted.date,
          projectId: frozen === undefined ? input.contextProjectId ?? null : frozen.projectId,
        });
        created = await createChatPiAgentSession({
          chatSession,
          sessionManager: chatSession.manager,
          ...prepared,
          ...(preparedResourceLoader === undefined ? {} : { preparedResourceLoader }),
          toolContext: {
            purpose: "execution",
            agentId: agent.id,
            longAgentId: agent.id,
            longAgentTurnId: turnId,
          },
        });
        const resolvedModel = created.session.model;
        // Model capability is authoritative at assembly: images against a
        // text-only model get a friendly in-channel reply, not a provider error.
        let capabilityNotice: string | undefined;
        if (resolvedModel !== undefined && images !== undefined && !resumePending) {
          try {
            assertModelSupportsImages(resolvedModel, images);
          } catch (error) {
            capabilityNotice = error instanceof Error ? error.message : String(error);
          }
        }
        const feedback = registerLiveTurn(chatHome, accepted, created.session, projectSessionContext(chatSession.manager.getEntries(), chatSession.manager.getLeafId()).messages);
        // A topic node round continues into `remember`; the queue keeps ONE live reference across both
        // phases, so the work segment must not close it on success.
        let keepLiveAfterWork = false;
        const unsubscribe = created.session.subscribe((event) => {
          feedback.publish(event);
          if (event.type === "message_end" && event.message.role === "assistant") {
            lastAssistant = event.message;
          }
        });
        try {
          if ((await readLongAgentState(chatHome)).turns.find(t => t.turnId === accepted.turnId)?.cancelRequested || feedback.cancelled)
            throw new FriendCancelledError();
          if (recoveredAssistant === undefined) {
            if (resumePending) await created.session.resumePendingTurn();
            else if (accepted.summaryDraft) {
              await created.session.sendCustomMessage({ customType: "chat.daily-summary-draft.v1", display: false, content: `内部日终草稿（尚未覆盖全天；正式总结由日历收尾生成）。只读整理当前历史，不调用工具或对外发送：\n${text}` }, { triggerTurn: true });
            } else if (capabilityNotice === undefined) {
              await created.session.prompt(
                text,
                images === undefined ? undefined : { images: [...images] },
              );
            }
          }
          keepLiveAfterWork = accepted.topicNode !== undefined && !feedback.cancelled;
        } finally {
          unsubscribe();
          if (!keepLiveAfterWork) feedback.close();
        }
        if (feedback.cancelled) throw new FriendCancelledError();
        if (capabilityNotice !== undefined && resolvedModel !== undefined) {
          // Channel users never see the Web UI: answer in-channel with a
          // friendly model-capability explanation instead of a failed Turn.
          // Mirror prompt()'s User entry first so the transcript stays
          // coherent even though no model call happened.
          const userMessage: UserMessage = {
            role: "user",
            content: [{ type: "text", text }, ...(images ?? [])],
            timestamp: Date.now(),
          };
          chatSession.manager.appendMessage(userMessage);
          const noticeMessage: AssistantMessage = {
            role: "assistant",
            api: resolvedModel.api,
            provider: resolvedModel.provider,
            model: resolvedModel.id,
            content: [{ type: "text", text: capabilityNotice }],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          };
          chatSession.manager.appendMessage(noticeMessage);
          appendChatLongAgentTurn(chatSession.manager, {
            turnId,
            longAgentId: agent.id,
            bindingId: projectAgent.id,
            source,
            channelType,
            inboundEventId,
            agentGroupContext,
            status: "completed",
            startedAt,
            completedAt: new Date().toISOString(),
            error: null,
          });
          chatSession.manager.flush();
          return {
            accepted: true,
            completed: true,
            sessionId: projectAgent.primarySessionId,
            projectLongAgentId: projectAgent.id,
            messageId: turnId,
            turnId,
            isNewSession,
            text: capabilityNotice,
            model: { provider: resolvedModel.provider, modelId: resolvedModel.id },
          };
        }
        if (lastAssistant === undefined) throw new Error("Pi Long Agent没有返回Assistant消息");
        if (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted") {
          throw new Error(lastAssistant.errorMessage ?? "Pi Long Agent执行失败");
        }
        const responseText = assistantText(lastAssistant);
        if (responseText === "") throw new Error("Pi Long Agent没有返回Assistant文本");
        appendChatLongAgentTurn(chatSession.manager, {
          turnId,
          longAgentId: agent.id,
          bindingId: projectAgent.id,
          source,
          channelType,
          inboundEventId,
          agentGroupContext,
          status: "completed",
          startedAt,
          completedAt: new Date().toISOString(),
          error: null,
        });
        chatSession.manager.flush();
        return {
          accepted: true,
          completed: true,
          sessionId: projectAgent.primarySessionId,
          projectLongAgentId: projectAgent.id,
          messageId: turnId,
          turnId,
          isNewSession,
          text: responseText,
          model: created.session.model === undefined
            ? null
            : { provider: created.session.model.provider, modelId: created.session.model.id },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendChatLongAgentTurn(chatSession.manager, {
          turnId,
          longAgentId: agent.id,
          bindingId: projectAgent.id,
          source,
          channelType,
          inboundEventId,
          agentGroupContext,
          status: error instanceof FriendCancelledError ? "cancelled" : "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          error: message,
        });
        chatSession.manager.flush();
        throw error;
      } finally {
        created?.session.dispose();
      }
    },
    { longAgentId: agent.id },
  );
}

export class FriendCancelledError extends Error { constructor() { super("本轮已取消；已有消息和工具结果已保留"); } }

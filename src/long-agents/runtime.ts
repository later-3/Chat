import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createChatPiAgentSession } from "../agents/pi-agent-session.js";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";
import type { WorkflowAgentDefinition } from "../workflows/agent-config.js";
import { readLongAgentRegistry } from "./storage.js";
import { ensureProjectLongAgent } from "./project-agent.js";
import {
  appendChatLongAgentTurn,
  collectChatLongAgentTurnMarkers,
  findChatLongAgentTurnResumeEntryId,
  latestChatLongAgentTurn,
  type ChatLongAgentTurnSource,
} from "./session-turn.js";
import type { LongAgentConfig } from "./types.js";
import {
  agentGroupContextRevisionOf,
  buildAgentGroupContextInstructions,
  readFrozenLongAgentAgentGroup,
  readLongAgentAgentGroup,
} from "./agent-group-service.js";

const CHAT_WEB_CHANNEL = "chat-web";
const MAX_LONG_AGENT_MESSAGE_CHARS = 100_000;

export interface ExecuteLongAgentTurnInput {
  readonly longAgentId: string;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly text: unknown;
  readonly chatHome?: string;
  /** Stable external idempotency key. Chat Web omits this and receives a new Turn ID. */
  readonly turnId?: string;
  readonly inboundEventId?: string;
  readonly source?: ChatLongAgentTurnSource;
  readonly channelType?: string | null;
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

function parseText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("text必须是非空字符串");
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

/** Runs one Long Agent turn through Chat's shared Pi assembly and native Session persistence. */
export async function executeLongAgentTurn(
  input: ExecuteLongAgentTurnInput,
): Promise<ExecuteLongAgentTurnResult> {
  const chatHome = resolveChatHome(input.chatHome);
  const text = parseText(input.text);
  const turnId = nonEmpty(input.turnId, "turnId") ?? randomUUID();
  const inboundEventId = nonEmpty(input.inboundEventId, "inboundEventId") ?? null;
  const registry = await readLongAgentRegistry(chatHome);
  const agent = registry.agents.find((candidate) => candidate.enabled && candidate.id === input.longAgentId);
  if (agent === undefined) throw new Error(`找不到可用LongAgent: ${input.longAgentId}`);
  await resolveProjectContext(input.projectId, chatHome);
  const { projectAgent, isNewSession } = await ensureProjectLongAgent({
    chatHome,
    projectId: input.projectId,
    agent,
    ...(input.sessionId === undefined ? {} : { requestedSessionId: input.sessionId }),
  });
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

      const groupContext = started?.agentGroupContext === null || started?.agentGroupContext === undefined
        ? await readLongAgentAgentGroup(agent.id, chatHome)
        : await readFrozenLongAgentAgentGroup(agent.id, started.agentGroupContext, chatHome);
      const agentGroupContext = agentGroupContextRevisionOf(groupContext);
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
        // Agent Group context is a per-turn snapshot, not Session data. Refresh
        // before Pi assembly so Web and Channel execute with the same Nano-owned
        // identity and OKF core memory. A valid cache is explicitly marked stale.
        const definition = createLongAgentDefinition(agent);
        created = await createChatPiAgentSession({
          chatSession,
          sessionManager: chatSession.manager,
          agent: {
            ...definition,
            customInstructions: [
              ...definition.customInstructions,
              { text: buildAgentGroupContextInstructions(groupContext) },
            ],
          },
          toolContext: {
            purpose: "execution",
            agentId: agent.id,
            longAgentId: agent.id,
            longAgentTurnId: turnId,
          },
        });
        const unsubscribe = created.session.subscribe((event) => {
          if (event.type === "message_end" && event.message.role === "assistant") {
            lastAssistant = event.message;
          }
        });
        try {
          if (recoveredAssistant === undefined) {
            if (resumePending) await created.session.resumePendingTurn();
            else await created.session.prompt(text);
          }
        } finally {
          unsubscribe();
        }
        if (lastAssistant === undefined) throw new Error("Pi Long Agent没有返回Assistant消息");
        if (lastAssistant.stopReason === "error") {
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
          status: "failed",
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
  );
}

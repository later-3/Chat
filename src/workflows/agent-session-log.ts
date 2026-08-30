import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { localTimestamp } from "../runtime-log.js";
import {
  createChatRunEventPublisher,
  type ChatRunStage,
} from "./chat-run-events.js";

function getAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

export interface AgentSessionLogSubscription {
  readonly getLastAssistantText: () => string;
  readonly getLastAssistantMessage: () => Extract<AgentMessage, { role: "assistant" }> | undefined;
  readonly finish: (closeStream: boolean) => Promise<void>;
}

/** Logs Pi AgentSession lifecycle events without logging message or tool data. */
export function subscribeAgentSessionLog(
  session: AgentSession,
  component: "pi" | "planner" | "memory" | "rule-curator",
  stage: ChatRunStage,
): AgentSessionLogSubscription {
  let turn = 0;
  let lastAssistantText = "";
  let lastAssistantMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
  const publisher = createChatRunEventPublisher(stage);
  const unsubscribe = session.subscribe((event) => {
    publisher.publishAgentEvent(event);
    if (event.type === "message_end" && event.message.role === "assistant") {
      lastAssistantText = getAssistantText(event.message);
      lastAssistantMessage = event.message;
    }
    if (event.type === "agent_start") {
      console.log(`${localTimestamp()} [${component}] agent started`);
    } else if (event.type === "turn_start") {
      turn += 1;
      console.log(`${localTimestamp()} [${component}] turn ${turn} started`);
    } else if (event.type === "tool_execution_start") {
      console.log(`${localTimestamp()} [${component}] tool started name=${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      console.log(
        `${localTimestamp()} [${component}] tool finished name=${event.toolName} status=${event.isError ? "error" : "ok"}`,
      );
    } else if (event.type === "turn_end") {
      console.log(`${localTimestamp()} [${component}] turn ${turn} finished`);
    } else if (event.type === "agent_end") {
      console.log(`${localTimestamp()} [${component}] agent ended willRetry=${String(event.willRetry)}`);
    } else if (event.type === "auto_retry_start") {
      console.log(
        `${localTimestamp()} [${component}] retry scheduled attempt=${event.attempt}/${event.maxAttempts} delayMs=${event.delayMs}`,
      );
    } else if (event.type === "compaction_start") {
      console.log(`${localTimestamp()} [${component}] compaction started reason=${event.reason}`);
    } else if (event.type === "compaction_end") {
      const status = event.aborted ? "aborted" : event.result === undefined ? "failed" : "completed";
      const error = event.errorMessage === undefined ? "" : ` error=${event.errorMessage}`;
      console.log(`${localTimestamp()} [${component}] compaction ${status} reason=${event.reason}${error}`);
    }
  });
  return {
    getLastAssistantText: () => lastAssistantText,
    getLastAssistantMessage: () => lastAssistantMessage,
    finish: async (closeStream) => {
      unsubscribe();
      await publisher.finish(closeStream);
    },
  };
}

import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
  resolveWorkflowAgentDefinition,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import { stripLegacyPlanningHandoffs } from "../planning-execution/context.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import { appendChatWorkflowStage } from "../workflow-stage.js";
import { PI_CODING_AGENT } from "./agents/pi-coding-agent.js";

export async function runPiCodingAgentPromptStep(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: PI_CODING_AGENT.id,
  });
  console.log(`${localTimestamp()} [pi] step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [pi] creating AgentSession`);

  const agent = await resolveWorkflowAgentDefinition({
    defaultAgent: PI_CODING_AGENT,
    cwd: chatSession.cwd,
    ...(input.agentConfigs?.[PI_CODING_AGENT.id] === undefined
      ? {}
      : { selection: input.agentConfigs[PI_CODING_AGENT.id] }),
  });
  const { session, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent,
    transformContext: stripLegacyPlanningHandoffs,
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("Pi Coding Agent没有创建持久Session文件");
  }

  console.log(`${localTimestamp()} [pi] source=${import.meta.resolve("@earendil-works/pi-coding-agent")}`);
  console.log(`${localTimestamp()} [pi] agentDir=${chatSession.agentDir}`);
  console.log(`${localTimestamp()} [pi] sessionDir=${chatSession.sessionDir}`);
  console.log(`${localTimestamp()} [pi] sessionFile=${sessionFile}`);
  console.log(
    `${localTimestamp()} [pi] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [pi] modelFallback=${modelFallbackMessage}`);
  }

  const observer = subscribeAgentSessionLog(session, "pi", {
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: PI_CODING_AGENT.id,
  });
  try {
    console.log(`${localTimestamp()} [pi] prompt submitted chars=${input.prompt.length}`);
    await session.prompt(input.prompt);
    console.log(
      `${localTimestamp()} [pi] prompt completed elapsedMs=${Date.now() - stepStartedAt}`,
    );
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("Pi Coding Agent没有返回Assistant文本");
    return {
      text,
      sessionId: session.sessionId,
      sessionFile,
      model: session.model === undefined
        ? null
        : { provider: session.model.provider, modelId: session.model.id },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [pi] step failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    throw error;
  } finally {
    await observer.finish(true);
    session.dispose();
    console.log(`${localTimestamp()} [pi] session disposed`);
  }
}

// The Agent may already have changed files or Session state before a failure.
runPiCodingAgentPromptStep.maxRetries = 0;

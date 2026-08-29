import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { localTimestamp } from "../runtime-log.js";
import { subscribeAgentSessionLog } from "./agent-session-log.js";
import { stripLegacyPlanningHandoffs } from "./planning-execution-context.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "./types.js";
import { appendChatWorkflowStage } from "./workflow-stage.js";

// `POST /run` uses this Prompt when the VS Code debug request has no body.
export const MINIMAL_PI_CODING_AGENT_PROMPT = `
回复你好。
`.trim();

/** Runs one user turn with Pi Coding Agent in the current Chat Session. */
export async function minimalPiCodingAgentWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";

  return runPiCodingAgentPromptStep(input);
}

export async function runPiCodingAgentPromptStep(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  /**
   * Workflow runs this function as a Step. The Step opens the persistent Chat
   * Session, creates a Pi Coding Agent runtime, and submits one user turn.
   */
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "minimal-pi-coding-agent",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  console.log(`${localTimestamp()} [pi] step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [pi] creating AgentSession`);

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    sessionManager: chatSession.manager,
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
    agentId: "pi-coding-agent",
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

// A failed Agent turn must not be repeated automatically because it may have
// already appended messages or changed files before the failure was reported.
runPiCodingAgentPromptStep.maxRetries = 0;

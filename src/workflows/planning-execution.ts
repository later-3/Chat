import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { localTimestamp } from "../runtime-log.js";
import { subscribeAgentSessionLog } from "./agent-session-log.js";
import {
  buildPlanningPrompt,
  MAX_PLANNING_RESULT_CHARS,
  PLANNING_EXECUTION_SYSTEM_PROMPT,
  PLANNING_SYSTEM_PROMPT,
} from "./planning-execution-prompts.js";
import {
  injectPlanningExecutionContext,
  stripLegacyPlanningHandoffs,
} from "./planning-execution-context.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "./types.js";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowMessage,
  appendChatWorkflowStage,
} from "./workflow-stage.js";

interface PlanningStepResult {
  readonly sessionId: string;
  readonly plan: string;
}

interface PlanningExecutionStepInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly prompt: string;
  readonly plan: string;
}

/** Runs Planner Agent and Pi Coding Agent sequentially in one Chat Session. */
export async function planningExecutionWorkflow(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use workflow";

  const planning = await runPlanningStep(input);
  return runPlanningExecutionStep({
    cwd: input.cwd,
    sessionId: planning.sessionId,
    workflowInvocationId: input.workflowInvocationId,
    prompt: input.prompt,
    plan: planning.plan,
  });
}

export async function runPlanningStep(
  input: ChatWorkflowInput,
): Promise<PlanningStepResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
    userPrompt: input.prompt,
  });
  const plannerSessionManager = SessionManager.forkInMemory(chatSession.manager);
  const settingsManager = SettingsManager.create(chatSession.cwd, chatSession.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    settingsManager,
    systemPromptOverride: () => PLANNING_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  console.log(`${localTimestamp()} [planner] step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [planner] creating AgentSession`);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    sessionManager: plannerSessionManager,
    settingsManager,
    resourceLoader,
    noTools: "all",
    transformContext: stripLegacyPlanningHandoffs,
  });
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [planner] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [planner] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "planner", {
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: "planner",
  });
  let completed = false;
  try {
    await session.prompt(buildPlanningPrompt(input.prompt));
    const plan = observer.getLastAssistantText();
    const plannerMessage = observer.getLastAssistantMessage();
    if (plan === "") throw new Error("Planner Agent没有返回计划文本");
    if (plannerMessage === undefined) throw new Error("Planner Agent没有返回Assistant消息");
    if (plan.length > MAX_PLANNING_RESULT_CHARS) {
      throw new Error(`规划结果不能超过${MAX_PLANNING_RESULT_CHARS}个字符`);
    }

    appendChatWorkflowMessage(chatSession.manager, {
      invocationId: input.workflowInvocationId,
      workflowId: "planning-execution",
      stageId: "plan",
      agentId: "planner",
      message: plannerMessage,
    });
    chatSession.manager.flush();
    console.log(
      `${localTimestamp()} [planner] completed chars=${plan.length} elapsedMs=${Date.now() - stepStartedAt}`,
    );
    completed = true;
    return {
      sessionId: chatSession.manager.getSessionId(),
      plan,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [planner] failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    throw error;
  } finally {
    await observer.finish(!completed);
    session.dispose();
    console.log(`${localTimestamp()} [planner] session disposed`);
  }
}

export async function runPlanningExecutionStep(
  input: PlanningExecutionStepInput,
): Promise<ChatWorkflowResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
    userPrompt: input.prompt,
    upstream: {
      stageId: "plan",
      agentId: "planner",
      output: input.plan,
    },
  });
  console.log(`${localTimestamp()} [pi] planning execution step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [pi] creating AgentSession`);

  const settingsManager = SettingsManager.create(chatSession.cwd, chatSession.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    settingsManager,
    appendSystemPromptOverride: (base) => [...base, PLANNING_EXECUTION_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    sessionManager: chatSession.manager,
    settingsManager,
    resourceLoader,
    transformContext: (messages) => injectPlanningExecutionContext(
      messages,
      input.prompt,
      input.plan,
      input.workflowInvocationId,
    ),
  });
  const sessionFile = session.sessionFile;
  if (sessionFile === undefined) {
    session.dispose();
    throw new Error("Pi Coding Agent没有打开持久Session文件");
  }
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [pi] modelFallback=${modelFallbackMessage}`);
  }
  console.log(
    `${localTimestamp()} [pi] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );

  const observer = subscribeAgentSessionLog(session, "pi", {
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: "pi-coding-agent",
  });
  try {
    await session.prompt(input.prompt);
    const text = observer.getLastAssistantText();
    if (text === "") throw new Error("Pi Coding Agent没有返回Assistant文本");
    console.log(
      `${localTimestamp()} [pi] planning execution completed elapsedMs=${Date.now() - stepStartedAt}`,
    );
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
      `${localTimestamp()} [pi] planning execution failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    throw error;
  } finally {
    await observer.finish(true);
    session.dispose();
    console.log(`${localTimestamp()} [pi] session disposed`);
  }
}

// Agent Steps can append messages and change files before reporting a failure.
// Automatic Step retries would repeat those effects.
runPlanningStep.maxRetries = 0;
runPlanningExecutionStep.maxRetries = 0;

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../../chat-session.js";
import { localTimestamp } from "../../runtime-log.js";
import {
  createWorkflowAgentSession,
  type ResolvedWorkflowAgentDefinition,
} from "../agent-definition.js";
import { subscribeAgentSessionLog } from "../agent-session-log.js";
import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";
import {
  appendChatWorkflowAgentInput,
  appendChatWorkflowMessage,
  appendChatWorkflowStage,
} from "../workflow-stage.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflow-configuration.js";
import {
  buildPlanningPrompt,
  MAX_PLANNING_RESULT_CHARS,
  PLANNER_AGENT,
} from "./agents/planner/index.js";
import { PLANNING_EXECUTION_AGENT } from "./agents/pi-coding-agent/index.js";
import {
  injectPlanningExecutionContext,
  stripLegacyPlanningHandoffs,
} from "./context.js";

interface PlanningStepResult {
  readonly sessionId: string;
  readonly plan: string;
  readonly executionAgent: ResolvedWorkflowAgentDefinition;
}

export interface PlanningExecutionStepInput {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workflowInvocationId: string;
  readonly prompt: string;
  readonly plan: string;
  readonly agent: ResolvedWorkflowAgentDefinition;
}

export async function runPlanningStep(
  input: ChatWorkflowInput,
): Promise<PlanningStepResult> {
  "use step";

  const stepStartedAt = Date.now();
  const chatSession = await openChatSession(input);
  const prepared = await prepareChatWorkflowTurnConfiguration(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    agents: [PLANNER_AGENT, PLANNING_EXECUTION_AGENT],
    cwd: chatSession.cwd,
    ...(chatSession.projectContext === undefined ? {} : { chatHome: chatSession.projectContext.chatHome }),
    ...(chatSession.projectContext === undefined ? {} : { projectDataDir: chatSession.projectContext.projectDataDir }),
    ...(input.defaultAgentConfigs === undefined ? {} : { defaults: input.defaultAgentConfigs }),
    ...(input.agentConfigs === undefined ? {} : { adjustments: input.agentConfigs }),
  });
  appendChatWorkflowStage(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: PLANNER_AGENT.id,
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "plan",
    agentId: PLANNER_AGENT.id,
    userPrompt: input.prompt,
  });
  const plannerSessionManager = SessionManager.forkInMemory(chatSession.manager);

  console.log(`${localTimestamp()} [planner] step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [planner] creating AgentSession`);
  const agent = prepared.agents[PLANNER_AGENT.id];
  const executionAgent = prepared.agents[PLANNING_EXECUTION_AGENT.id];
  if (agent === undefined || executionAgent === undefined) {
    throw new Error("本轮配置缺少Planning Workflow Agent");
  }
  const { session, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: plannerSessionManager,
    agent,
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
    agentId: PLANNER_AGENT.id,
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
      agentId: PLANNER_AGENT.id,
      message: plannerMessage,
    });
    chatSession.manager.flush();
    console.log(
      `${localTimestamp()} [planner] completed chars=${plan.length} elapsedMs=${Date.now() - stepStartedAt}`,
    );
    completed = true;
    return { sessionId: chatSession.manager.getSessionId(), plan, executionAgent };
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
    agentId: PLANNING_EXECUTION_AGENT.id,
  });
  appendChatWorkflowAgentInput(chatSession.manager, {
    invocationId: input.workflowInvocationId,
    workflowId: "planning-execution",
    stageId: "execute",
    agentId: PLANNING_EXECUTION_AGENT.id,
    userPrompt: input.prompt,
    upstream: {
      stageId: "plan",
      agentId: PLANNER_AGENT.id,
      output: input.plan,
    },
  });
  console.log(`${localTimestamp()} [pi] planning execution step starting cwd=${chatSession.cwd}`);
  console.log(`${localTimestamp()} [pi] creating AgentSession`);

  const { session, modelFallbackMessage } = await createWorkflowAgentSession({
    chatSession,
    sessionManager: chatSession.manager,
    agent: input.agent,
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
    agentId: PLANNING_EXECUTION_AGENT.id,
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
runPlanningStep.maxRetries = 0;
runPlanningExecutionStep.maxRetries = 0;

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { localTimestamp } from "../runtime-log.js";
import {
  runPiCodingAgentStep,
  type MinimalPiCodingAgentWorkflowInput,
  type MinimalPiCodingAgentWorkflowResult,
} from "./minimal-pi-coding-agent.js";
import {
  buildPlanningPrompt,
  MAX_PLANNING_RESULT_CHARS,
  PLANNING_SYSTEM_PROMPT,
} from "./planning-execution-prompts.js";

/**
 * 先用一个无工具的pi-agent-core Agent生成计划，再把计划交给Pi Coding Agent执行。
 * Planner不创建Session文件；用户可继续使用执行阶段返回的Pi Session。
 */
export async function planningExecutionWorkflow(
  input: MinimalPiCodingAgentWorkflowInput,
): Promise<MinimalPiCodingAgentWorkflowResult> {
  "use workflow";

  const plan = await runPlanningStep(input);
  return runPiCodingAgentStep({ ...input, executionPlan: plan });
}

async function runPlanningStep(input: MinimalPiCodingAgentWorkflowInput): Promise<string> {
  "use step";

  const stepStartedAt = Date.now();
  const cwd = resolve(input.cwd);
  const chatProjectDir = resolve(process.cwd());
  const agentDir = resolve(chatProjectDir, ".pi/agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });

  console.log(`${localTimestamp()} [planner] step starting cwd=${cwd}`);

  // Planner复用Chat/.pi/agent中的模型和认证配置，但不创建Coding AgentSession。
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const defaultProvider = settingsManager.getDefaultProvider();
  const defaultModelId = settingsManager.getDefaultModel();
  const configuredDefault = defaultProvider === undefined || defaultModelId === undefined
    ? undefined
    : modelRuntime.getModel(defaultProvider, defaultModelId);
  const model = configuredDefault !== undefined
    && modelRuntime.hasConfiguredAuth(configuredDefault.provider)
    ? configuredDefault
    : modelRuntime.getAvailableSnapshot()[0];
  if (model === undefined) {
    throw new Error("规划阶段没有可用模型，请检查Chat/.pi/agent中的模型和认证配置");
  }

  /**
   * Planner直接使用pi-agent-core。`tools: []`表示它只能返回文本计划；
   * ModelRuntime负责按Pi配置向实际Provider发起请求，且关闭Provider自动重试。
   */
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: PLANNING_SYSTEM_PROMPT,
      tools: [],
      thinkingLevel: "off",
    },
    streamFn: (streamModel, context, options) => modelRuntime.streamSimple(
      streamModel,
      context,
      { ...options, maxRetries: 0, maxRetryDelayMs: 0 },
    ),
    maxRetryDelayMs: 0,
  });

  console.log(`${localTimestamp()} [planner] model=${model.provider}/${model.id}`);

  try {
    await agent.prompt(buildPlanningPrompt(input.prompt));
    const assistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const plan = assistant?.role === "assistant"
      ? assistant.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim()
      : "";
    if (plan === "") throw new Error("规划阶段没有返回计划文本");
    if (plan.length > MAX_PLANNING_RESULT_CHARS) {
      throw new Error(`规划结果不能超过${MAX_PLANNING_RESULT_CHARS}个字符`);
    }
    console.log(
      `${localTimestamp()} [planner] completed chars=${plan.length} elapsedMs=${Date.now() - stepStartedAt}`,
    );
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [planner] failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    throw error;
  }
}

runPlanningStep.maxRetries = 0;

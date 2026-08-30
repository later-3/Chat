import { dirname, join, resolve } from "node:path";
import type {
  AgentContextTransform,
  AgentSession,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ChatSession } from "../chat-session.js";
import { getProjectTrust } from "../projects/trust.js";
import { ensureChatArchitectureSkill } from "../skills/runtime.js";
import type { WorkflowAgentDefinition } from "./agent-config.js";

export {
  parseWorkflowAgentDefinition,
  parseAgentConfigSelection,
  type AgentConfigSelection,
  type AgentPromptResourceSelection,
  type ResolvedWorkflowAgentDefinition,
  type WorkflowAgentDefinition,
  type WorkflowAgentResources,
} from "./agent-config.js";
export { resolveWorkflowAgentDefinition } from "./agent-config-loader.js";

export interface CreateWorkflowAgentSessionOptions {
  readonly chatSession: ChatSession;
  readonly sessionManager: SessionManager;
  readonly agent: WorkflowAgentDefinition;
  readonly additionalSkillPaths?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly transformContext?: AgentContextTransform;
}

/** Workflow-owned additions applied identically during execution and inspection. */
export interface WorkflowAgentSessionExtensions {
  readonly additionalSkillPaths?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly transformContext?: AgentContextTransform;
}

export interface CreatedWorkflowAgentSession {
  readonly session: AgentSession;
  readonly resourceLoader: DefaultResourceLoader;
  readonly modelFallbackMessage?: string;
}

/** Wraps Chat-owned additions in one visible section of Pi's System Prompt. */
export function buildChatAgentCustomInstructions(
  instructions: WorkflowAgentDefinition["customInstructions"],
): string | undefined {
  const content = instructions.map(({ text }) => text.trim()).filter((value) => value !== "");
  if (content.length === 0) return undefined;
  return [
    "<chat_agent_custom_instructions>",
    content.join("\n\n"),
    "</chat_agent_custom_instructions>",
  ].join("\n");
}

/**
 * Creates one Pi AgentSession from the Agent definition owned by a Workflow.
 * Session selection stays with Chat; Agent capability assembly is centralized
 * here so individual Workflows do not recreate Pi's ResourceLoader setup.
 */
export async function createWorkflowAgentSession(
  options: CreateWorkflowAgentSessionOptions,
): Promise<CreatedWorkflowAgentSession> {
  const { agent, chatSession } = options;
  const projectTrusted = chatSession.projectContext === undefined
    ? true
    : (await getProjectTrust(chatSession.projectContext.projectId, chatSession.projectContext.chatHome)).trusted;
  const architectureSkillPath = await ensureChatArchitectureSkill(
    resolve(dirname(chatSession.agentDir), "runtime"),
  );
  const settingsManager = SettingsManager.create(
    chatSession.cwd,
    chatSession.agentDir,
    { projectTrusted },
  );
  const projectResourceDir = chatSession.projectContext?.projectConfigDir;
  const customInstructions = buildChatAgentCustomInstructions(agent.customInstructions);
  const replacementSystemPrompt = agent.systemPrompt.mode === "replace"
    ? agent.systemPrompt.text
    : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    settingsManager,
    ...(agent.resources.mode === "inherit"
      ? {}
      : {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          additionalExtensionPaths: [
            ...agent.resources.extensionPaths,
            ...agent.resources.pluginSources,
          ],
        }),
    ...(agent.resources.mode === "inherit" && projectTrusted && projectResourceDir !== undefined
      ? {
          additionalExtensionPaths: [resolve(projectResourceDir, "extensions")],
          additionalPromptTemplatePaths: [resolve(projectResourceDir, "prompts")],
        }
      : {}),
    additionalSkillPaths: [
      architectureSkillPath,
      ...(agent.resources.mode === "inherit" && projectTrusted && projectResourceDir !== undefined
        ? [resolve(projectResourceDir, "skills")]
        : []),
      ...(agent.resources.mode === "inherit" ? [] : agent.resources.skillPaths),
      ...(options.additionalSkillPaths ?? []),
    ],
    ...(replacementSystemPrompt === undefined
      ? {}
      : { systemPromptOverride: () => replacementSystemPrompt }),
    ...(customInstructions === undefined
      ? {}
      : { appendSystemPromptOverride: (base) => [...base, customInstructions] }),
  });
  await resourceLoader.reload();

  let modelRuntime: ModelRuntime | undefined;
  let model;
  if (agent.model !== undefined) {
    modelRuntime = await ModelRuntime.create({
      authPath: join(chatSession.agentDir, "auth.json"),
      modelsPath: join(chatSession.agentDir, "models.json"),
    });
    model = modelRuntime.getModel(agent.model.provider, agent.model.modelId);
    if (model === undefined) {
      throw new Error(`找不到Agent配置的Model: ${agent.model.provider}/${agent.model.modelId}`);
    }
    if (!modelRuntime.hasConfiguredAuth(model.provider)) {
      throw new Error(`Agent配置的Provider没有认证: ${model.provider}`);
    }
  }

  const created = await createAgentSession({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    sessionManager: options.sessionManager,
    settingsManager,
    resourceLoader,
    ...(options.customTools === undefined ? {} : { customTools: [...options.customTools] }),
    ...(modelRuntime === undefined ? {} : { modelRuntime }),
    ...(model === undefined ? {} : { model }),
    ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent.tools.mode === "none"
      ? { noTools: "all" as const }
      : agent.tools.mode === "explicit"
        ? { tools: [...agent.tools.names], excludeTools: [...agent.tools.exclude] }
        : {}),
    ...(options.transformContext === undefined
      ? {}
      : { transformContext: options.transformContext }),
  });

  if (agent.tools.mode === "explicit") {
    const available = new Set(created.session.getAllTools().map((tool) => tool.name));
    const unknown = [...agent.tools.names, ...agent.tools.exclude].filter((name) => !available.has(name));
    if (unknown.length > 0) {
      created.session.dispose();
      throw new Error(`Agent配置包含不存在的Tool: ${[...new Set(unknown)].join(", ")}`);
    }
  }

  const context = options.sessionManager.buildSessionContext();
  if (
    created.session.model !== undefined
    && (
      context.model?.provider !== created.session.model.provider
      || context.model.modelId !== created.session.model.id
    )
  ) {
    options.sessionManager.appendModelChange(created.session.model.provider, created.session.model.id);
  }
  if (context.thinkingLevel !== created.session.thinkingLevel) {
    options.sessionManager.appendThinkingLevelChange(created.session.thinkingLevel);
  }
  return { ...created, resourceLoader };
}

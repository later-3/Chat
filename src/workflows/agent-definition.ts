import { join, resolve } from "node:path";
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
import type {
  ChatSessionToolResource,
  ChatToolRuntimeContext,
  ResolvedChatTool,
} from "../tools/framework.js";
import { resolveChatSystemTools } from "../tools/registry.js";
import { describeResourceVersion, qualifiedResourceAddress } from "../resources/version.js";
import { loadChatAgentContextFiles } from "./agent-context-files.js";
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
  readonly toolContext?: Pick<
    ChatToolRuntimeContext,
    "purpose" | "workflowId" | "workflowInvocationId" | "stageId" | "agentId"
  >;
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
  readonly chatTools: readonly ResolvedChatTool[];
  readonly toolResources: readonly ChatSessionToolResource[];
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
  const settingsManager = SettingsManager.create(chatSession.cwd, chatSession.agentDir);
  const projectResourceDir = chatSession.projectContext?.projectConfigDir;
  const customInstructions = buildChatAgentCustomInstructions(agent.customInstructions);
  const replacementSystemPrompt = agent.systemPrompt.mode === "replace"
    ? agent.systemPrompt.text
    : undefined;
  const contextFiles = await loadChatAgentContextFiles({
    agentDir: chatSession.agentDir,
    projectRoot: chatSession.projectContext?.projectRoot ?? chatSession.cwd,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: chatSession.cwd,
    agentDir: chatSession.agentDir,
    settingsManager,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
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
    ...(agent.resources.mode === "inherit" && projectResourceDir !== undefined
      ? {
          additionalProjectExtensionPaths: [resolve(projectResourceDir, "extensions")],
          additionalPromptTemplatePaths: [resolve(projectResourceDir, "prompts")],
        }
      : {}),
    additionalSkillPaths: [
      ...(agent.resources.mode === "inherit" && projectResourceDir !== undefined
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

  const toolAddresses = agent.tools.mode === "none" ? [] : agent.tools.addresses ?? [];
  let chatTools: ResolvedChatTool[] = [];
  if (toolAddresses.length > 0) {
    if (chatSession.projectContext === undefined || options.toolContext === undefined) {
      throw new Error(`Agent ${agent.id}配置了Chat系统Tool，但缺少Project或Tool运行上下文`);
    }
    chatTools = resolveChatSystemTools(toolAddresses, {
      ...options.toolContext,
      projectId: chatSession.projectContext.projectId,
      chatHome: chatSession.projectContext.chatHome,
      cwd: chatSession.cwd,
      sessionManager: options.sessionManager,
      sessionId: options.sessionManager.getSessionId(),
    });
  }
  const customTools = [
    ...(options.customTools ?? []),
    ...chatTools.map((tool) => tool.definition),
  ];
  const customToolNames = new Set<string>();
  for (const tool of customTools) {
    if (customToolNames.has(tool.name)) throw new Error(`Agent装配了重复的Custom Tool: ${tool.name}`);
    customToolNames.add(tool.name);
  }

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
    ...(customTools.length === 0 ? {} : { customTools }),
    ...(modelRuntime === undefined ? {} : { modelRuntime }),
    ...(model === undefined ? {} : { model }),
    ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent.tools.mode === "none"
      ? { noTools: "all" as const }
      : agent.tools.mode === "explicit"
        ? {
            tools: [...new Set([...agent.tools.names, ...chatTools.map((tool) => tool.manifest.name)])],
            excludeTools: [...agent.tools.exclude],
          }
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

  const chatToolsByName = new Map(chatTools.map((tool) => [tool.manifest.name, tool]));
  const toolResources = await Promise.all(created.session.getAllTools().map(async (tool): Promise<ChatSessionToolResource> => {
    const chatTool = chatToolsByName.get(tool.name);
    if (chatTool !== undefined) {
      return { name: tool.name, address: chatTool.address, version: chatTool.version };
    }
    const fileVersion = await describeResourceVersion(tool.sourceInfo.path);
    return {
      name: tool.name,
      address: qualifiedResourceAddress({
        kind: "tool",
        id: tool.name,
        scope: tool.sourceInfo.scope,
        ...(chatSession.projectContext === undefined ? {} : { projectId: chatSession.projectContext.projectId }),
      }),
      ...(fileVersion?.contentHash === undefined ? {} : { version: fileVersion.contentHash }),
    };
  }));

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
  return { ...created, resourceLoader, chatTools, toolResources };
}

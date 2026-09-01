import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../chat-home.js";
import { resolveProjectContext } from "../projects/registry.js";
import {
  createWorkflowAgentSession,
  type AgentConfigSelection,
  type WorkflowAgentDefinition,
} from "./agent-definition.js";
import { resolveWorkflowAgentDefinition } from "./agent-config-loader.js";
import type { PrepareChatWorkflowAgentSession } from "./registry.js";
import { describeResourceVersion, qualifiedResourceAddress } from "../resources/version.js";
import { readAgentDurableConfig } from "./agent-model-config.js";

const MAX_VISIBLE_RESOURCE_BYTES = 1_000_000;

interface AgentInspectionOptions {
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly defaultAgent: WorkflowAgentDefinition;
  readonly selection?: AgentConfigSelection;
  readonly workflowId?: string;
  readonly agentId?: string;
  readonly stageId?: string;
  readonly prepareAgentSession?: PrepareChatWorkflowAgentSession;
}

async function readVisibleResource(path: string): Promise<{ content?: string; error?: string }> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { error: "资源路径不是文件" };
    if (info.size > MAX_VISIBLE_RESOURCE_BYTES) {
      return { error: `资源文件超过${MAX_VISIBLE_RESOURCE_BYTES}字节，未读取内容` };
    }
    return { content: await readFile(path, "utf8") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function extensionCapabilities(extension: ReturnType<CreatedInspectionSession["resourceLoader"]["getExtensions"]>["extensions"][number]) {
  return {
    tools: [...extension.tools.keys()],
    commands: [...extension.commands.keys()],
    flags: [...extension.flags.keys()],
    shortcuts: [...extension.shortcuts.keys()],
    eventHandlers: [...extension.handlers.keys()],
    hasMarkdownTransformer: extension.markdownTransformer !== undefined,
  };
}

type CreatedInspectionSession = Awaited<ReturnType<typeof createWorkflowAgentSession>>;

/** Resolves and creates the same Pi AgentSession used by Workflow execution, without sending a Prompt. */
export async function inspectWorkflowAgent(options: AgentInspectionOptions) {
  const projectContext = options.projectId === undefined
    ? undefined
    : await resolveProjectContext(options.projectId, options.chatHome);
  const home = projectContext === undefined ? await ensureChatHome(options.chatHome) : undefined;
  const cwd = projectContext?.cwd ?? options.cwd;
  const agent = await resolveWorkflowAgentDefinition({
    defaultAgent: options.defaultAgent,
    cwd,
    ...(projectContext === undefined ? {} : { chatHome: projectContext.chatHome }),
    ...(projectContext !== undefined && options.workflowId !== undefined
      ? {
          durableModelConfig: {
            projectDataDir: projectContext.projectDataDir,
            workflowId: options.workflowId,
            agentId: options.agentId ?? options.defaultAgent.id,
          },
        }
      : {}),
    ...(options.selection === undefined ? {} : { selection: options.selection }),
  });
  const durableConfig = projectContext === undefined || options.workflowId === undefined
    ? undefined
    : await readAgentDurableConfig(
        projectContext.projectDataDir,
        options.workflowId,
        options.agentId ?? options.defaultAgent.id,
      );
  const sessionManager = SessionManager.inMemory(cwd);
  const workflowId = options.workflowId ?? "agent-inspection";
  const agentId = options.agentId ?? options.defaultAgent.id;
  const sessionExtensions = await options.prepareAgentSession?.({
    purpose: "inspection",
    ...(projectContext === undefined ? {} : { projectId: projectContext.projectId, chatHome: projectContext.chatHome }),
    cwd,
    workflowId,
    agentId,
    sessionManager,
    sessionId: sessionManager.getSessionId(),
    workflowInvocationId: `inspection:${workflowId}:${agentId}`,
    userPrompt: "",
  });
  const created = await createWorkflowAgentSession({
    chatSession: {
      ...(projectContext === undefined ? {} : { projectId: projectContext.projectId, projectContext }),
      cwd,
      agentDir: projectContext?.agentDir ?? home!.agentDir,
      sessionDir: projectContext?.sessionDir ?? home!.runtimeDir,
      manager: sessionManager,
    },
    sessionManager,
    agent,
    ...(sessionExtensions ?? {}),
    toolContext: {
      purpose: "inspection",
      workflowId,
      workflowInvocationId: `inspection:${workflowId}:${agentId}`,
      stageId: options.stageId ?? agentId,
      agentId,
    },
  });

  try {
    const { resourceLoader, session } = created;
    const skillResult = resourceLoader.getSkills();
    const skills = await Promise.all(skillResult.skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
      sourceInfo: skill.sourceInfo,
      address: qualifiedResourceAddress({
        kind: "skill",
        id: skill.name,
        scope: skill.sourceInfo.scope,
        ...(projectContext === undefined ? {} : { projectId: projectContext.projectId }),
        workflowId,
        agentId,
      }),
      version: await describeResourceVersion(skill.filePath),
      ...await readVisibleResource(skill.filePath),
    })));
    const extensionResult = resourceLoader.getExtensions();
    const extensions = await Promise.all(extensionResult.extensions.map(async (extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      sourceInfo: extension.sourceInfo,
      address: qualifiedResourceAddress({
        kind: "extension",
        id: basename(extension.resolvedPath),
        scope: extension.sourceInfo.scope,
        ...(projectContext === undefined ? {} : { projectId: projectContext.projectId }),
        workflowId,
        agentId,
      }),
      version: await describeResourceVersion(extension.resolvedPath),
      capabilities: extensionCapabilities(extension),
    })));
    const promptResult = resourceLoader.getPrompts();
    const prompts = await Promise.all(promptResult.prompts.map(async (prompt) => ({
      name: prompt.name,
      description: prompt.description,
      filePath: prompt.filePath,
      content: prompt.content,
      sourceInfo: prompt.sourceInfo,
      address: qualifiedResourceAddress({
        kind: "prompt",
        id: prompt.name,
        scope: prompt.sourceInfo.scope,
        ...(projectContext === undefined ? {} : { projectId: projectContext.projectId }),
        workflowId,
        agentId,
      }),
      version: await describeResourceVersion(prompt.filePath),
    })));

    const pluginResources = new Map<string, {
      source: string;
      scope: string;
      skills: string[];
      extensions: string[];
      prompts: string[];
    }>();
    const addPluginResource = (
      sourceInfo: { source: string; scope: string; origin: string },
      kind: "skills" | "extensions" | "prompts",
      path: string,
    ) => {
      if (sourceInfo.origin !== "package") return;
      const key = `${sourceInfo.scope}\0${sourceInfo.source}`;
      const plugin = pluginResources.get(key) ?? {
        source: sourceInfo.source,
        scope: sourceInfo.scope,
        skills: [],
        extensions: [],
        prompts: [],
      };
      plugin[kind].push(path);
      pluginResources.set(key, plugin);
    };
    for (const skill of skills) addPluginResource(skill.sourceInfo, "skills", skill.filePath);
    for (const extension of extensions) addPluginResource(extension.sourceInfo, "extensions", extension.resolvedPath);
    for (const prompt of prompts) addPluginResource(prompt.sourceInfo, "prompts", prompt.filePath);

    const activeTools = new Set(session.getActiveToolNames());
    const chatToolsByName = new Map(created.chatTools.map((tool) => [tool.manifest.name, tool]));
    return {
      agent: {
        ...agent,
        effectiveModel: session.model === undefined
          ? null
          : { provider: session.model.provider, modelId: session.model.id },
        effectiveThinkingLevel: session.thinkingLevel,
        durableConfig: durableConfig ?? null,
      },
      prompt: {
        final: session.systemPrompt,
        base: {
          mode: agent.systemPrompt.mode,
          ...(agent.systemPrompt.mode === "replace" ? { text: agent.systemPrompt.text } : {}),
          sourcePath: resourceLoader.getSystemPromptSource()?.path ?? null,
        },
        append: resourceLoader.getAppendSystemPrompt().map((text, index) => ({
          text,
          sourcePath: resourceLoader.getAppendSystemPromptSources()[index]?.path ?? null,
        })),
        contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
      },
      tools: await Promise.all(session.getAllTools().map(async (tool) => {
        const chatTool = chatToolsByName.get(tool.name);
        const sourceInfo = chatTool === undefined
          ? tool.sourceInfo
          : {
              path: `<chat-system:${chatTool.manifest.id}>`,
              source: "chat-system",
              scope: "system",
              origin: "builtin",
            };
        return {
          name: tool.name,
          label: session.getToolDefinition(tool.name)?.label ?? tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines ?? [],
          sourceInfo,
          address: chatTool?.address ?? qualifiedResourceAddress({
            kind: "tool",
            id: tool.name,
            scope: tool.sourceInfo.scope,
            ...(projectContext === undefined ? {} : { projectId: projectContext.projectId }),
            workflowId,
            agentId,
          }),
          version: chatTool === undefined ? await describeResourceVersion(tool.sourceInfo.path) : null,
          ...(chatTool === undefined
            ? {}
            : {
                toolVersion: chatTool.version,
                risk: chatTool.manifest.risk,
                permissions: chatTool.manifest.permissions,
              }),
          active: activeTools.has(tool.name),
        };
      })),
      skills,
      extensions,
      plugins: [...pluginResources.values()],
      prompts,
      promptResources: agent.customInstructions.flatMap((instruction) => (
        instruction.promptResource === undefined ? [] : [instruction.promptResource]
      )),
      diagnostics: [
        ...skillResult.diagnostics.map((diagnostic) => ({ resource: "skill", ...diagnostic })),
        ...extensionResult.errors.map((diagnostic) => ({
          resource: "extension",
          type: "error",
          path: diagnostic.path,
          message: diagnostic.error,
        })),
        ...promptResult.diagnostics.map((diagnostic) => ({ resource: "prompt", ...diagnostic })),
      ],
    };
  } finally {
    created.session.dispose();
  }
}

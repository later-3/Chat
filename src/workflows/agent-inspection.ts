import { readFile, stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureChatDataLayout } from "../chat-data.js";
import {
  createWorkflowAgentSession,
  type AgentConfigSelection,
  type WorkflowAgentDefinition,
} from "./agent-definition.js";
import { resolveWorkflowAgentDefinition } from "./agent-config-loader.js";
import type { PrepareChatWorkflowAgentSession } from "./registry.js";

const MAX_VISIBLE_RESOURCE_BYTES = 1_000_000;

interface AgentInspectionOptions {
  readonly cwd: string;
  readonly defaultAgent: WorkflowAgentDefinition;
  readonly selection?: AgentConfigSelection;
  readonly workflowId?: string;
  readonly agentId?: string;
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
  const dataPaths = await ensureChatDataLayout();
  const agent = await resolveWorkflowAgentDefinition({
    defaultAgent: options.defaultAgent,
    cwd: options.cwd,
    ...(options.selection === undefined ? {} : { selection: options.selection }),
  });
  const sessionManager = SessionManager.inMemory(options.cwd);
  const workflowId = options.workflowId ?? "agent-inspection";
  const agentId = options.agentId ?? options.defaultAgent.id;
  const sessionExtensions = await options.prepareAgentSession?.({
    purpose: "inspection",
    cwd: options.cwd,
    workflowId,
    agentId,
    sessionId: sessionManager.getSessionId(),
    workflowInvocationId: `inspection:${workflowId}:${agentId}`,
  });
  const created = await createWorkflowAgentSession({
    chatSession: {
      cwd: options.cwd,
      agentDir: dataPaths.agentDir,
      sessionDir: dataPaths.sessionDir,
      manager: sessionManager,
    },
    sessionManager,
    agent,
    ...(sessionExtensions ?? {}),
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
      ...await readVisibleResource(skill.filePath),
    })));
    const extensionResult = resourceLoader.getExtensions();
    const extensions = extensionResult.extensions.map((extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      sourceInfo: extension.sourceInfo,
      capabilities: extensionCapabilities(extension),
    }));
    const promptResult = resourceLoader.getPrompts();
    const prompts = promptResult.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      filePath: prompt.filePath,
      content: prompt.content,
      sourceInfo: prompt.sourceInfo,
    }));

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
    return {
      agent: {
        ...agent,
        effectiveModel: session.model === undefined
          ? null
          : { provider: session.model.provider, modelId: session.model.id },
        effectiveThinkingLevel: session.thinkingLevel,
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
      tools: session.getAllTools().map((tool) => ({
        name: tool.name,
        label: session.getToolDefinition(tool.name)?.label ?? tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines ?? [],
        sourceInfo: tool.sourceInfo,
        active: activeTools.has(tool.name),
      })),
      skills,
      extensions,
      plugins: [...pluginResources.values()],
      prompts,
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

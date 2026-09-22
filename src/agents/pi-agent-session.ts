import { freezeAssemblyResources, freezeAssemblyTools, validateFrozenAssemblyResources } from "./assembly-resources.js";
import { applyScopeToCapabilities } from "../long-agents/scope.js";
import { resolveChatAssemblyContext, freezeWorkflowProjectContext, projectContextInstructions, collaborationInstructions, persistAssemblySnapshot, type ChatAgentInvocation, type ChatAssemblySnapshot } from "./assembly-context.js";
import { scopedFileTools } from "./scoped-file-tools.js";
import { join, resolve } from "node:path";
import { projectExtensionPaths } from "../resources/project-extension-paths.js";
import type {
  AgentContextTransform,
  AgentSession,
  CreateAgentSessionOptions,
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
import { describeResourceVersion, qualifiedResourceAddress } from "../resources/version.js";
import type {
  ChatSessionToolResource,
  ChatToolRuntimeContext,
  ResolvedChatTool,
} from "../tools/framework.js";
import { resolveChatSystemTools } from "../tools/registry.js";
import type { WorkflowAgentDefinition } from "../workflows/agent-config.js";

/**
 * Agent capability definition shared by Workflow and Long Agent callers.
 * The existing serializable shape remains stable while execution ownership
 * moves to the Chat-wide Pi assembly layer.
 */
export type ChatPiAgentDefinition = WorkflowAgentDefinition;

export interface CreateChatPiAgentSessionOptions {
  /** 已授权的 Project/Chat Home/cwd；Tool 身份必须由此派生，不能信任模型传入的路径或 ID。 */
  readonly chatSession: ChatSession;
  readonly sessionManager: SessionManager;
  /** 本轮已解析的有效能力；不要在公共装配内重新读取另一份 Agent 选择。 */
  readonly agent: ChatPiAgentDefinition;
  readonly invocation?: ChatAgentInvocation;
  /** Trusted, already loaded resources retained by the acceptance worker for this exact turn. */
  readonly preparedResourceLoader?: DefaultResourceLoader;
  readonly additionalSkillPaths?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly transformContext?: AgentContextTransform;
  /**
   * Fail-closed gate invoked by the public Pi assembly immediately before each provider request
   * (including tool continuations). Chat uses it for the frozen root-budget admission, so every real
   * model call — not just the first one in a prompt — is checked and counted at the request boundary.
   */
  readonly providerRequestGate?: NonNullable<CreateAgentSessionOptions["providerRequestGate"]>;
  readonly toolContext?: Omit<
    ChatToolRuntimeContext,
    "projectId" | "chatHome" | "cwd" | "sessionManager" | "sessionId"
  >;
}

export interface ChatPiAgentSessionExtensions {
  readonly additionalSkillPaths?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly transformContext?: AgentContextTransform;
}

export interface CreatedChatPiAgentSession {
  readonly session: AgentSession;
  readonly resourceLoader: DefaultResourceLoader;
  readonly chatTools: readonly ResolvedChatTool[];
  readonly toolResources: readonly ChatSessionToolResource[];
  readonly modelFallbackMessage?: string;
  readonly assemblySnapshot?: ChatAssemblySnapshot;
}

/** Wraps Chat-owned additions in one visible section of Pi's System Prompt. */
export function buildChatAgentCustomInstructions(
  instructions: ChatPiAgentDefinition["customInstructions"],
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
 * Creates the one Pi AgentSession assembly used by every Chat execution mode.
 * Callers own product lifecycle and tracing; Model, resources, Tools and Pi
 * Session persistence are assembled only here.
 *
 * 调试顺序：agent 有效定义 → reload 后的资源/diagnostics → created.session
 * 的实际模型与 active tools。发现资源不代表启用，更不代表模型调用过它。
 * 本函数不发送 prompt；调用方负责执行、订阅事件并最终 dispose()。
 * 场景与断点见 docs/development/debugging/configuration-resources.md。
 */
export async function createChatPiAgentSession(
  options: CreateChatPiAgentSessionOptions,
): Promise<CreatedChatPiAgentSession> {
  const { chatSession } = options;
  const assembly = options.invocation === undefined ? undefined : await resolveChatAssemblyContext({
    chatSession, sessionManager: options.sessionManager, agent: options.agent, invocation: options.invocation,
  });
  const agent = assembly?.snapshot.agent ?? options.agent;
  const scope = assembly?.snapshot.scope ?? null;
  const scopeGrants = scope === null ? null : scope.allowedTools;
  const cwd = assembly?.snapshot.cwd ?? chatSession.cwd;
  const workProject = assembly === undefined ? chatSession.projectContext : assembly.project ?? undefined;
  const settingsManager = assembly?.settingsManager ?? SettingsManager.create(cwd, chatSession.agentDir);
  const projectResourceDir = workProject?.projectConfigDir;
  const replacementSystemPrompt = agent.systemPrompt.mode === "replace" ? agent.systemPrompt.text : undefined;
  const workflowKey = options.toolContext?.purpose === "execution" && options.toolContext.workflowInvocationId !== undefined
    ? `workflow:${options.toolContext.workflowInvocationId}:${options.toolContext.stageId ?? "agent"}:${agent.id}` : undefined;
  const assemblyKey = assembly?.snapshot.turnId ?? workflowKey;
  const workflowContext = assembly === undefined ? await freezeWorkflowProjectContext({
    manager: options.sessionManager, key: workflowKey, projectId: workProject?.projectId,
    agentDir: chatSession.agentDir, projectRoot: workProject?.projectRoot ?? cwd,
    ...(workProject === undefined ? {} : { project: {
      projectId: workProject.projectId, name: workProject.name, description: workProject.description,
      projectRoot: workProject.projectRoot, cwd,
    } }),
  }) : undefined;
  const declaredContextFiles = assembly?.snapshot.contextFiles ?? workflowContext?.files ?? [];
  // A conversation turn only reads the Friend's own identity files; Personal files of any other
  // origin are excluded before the resource loader can read them.
  const contextFiles = scope === null || scope.include.personalContextFiles
    ? declaredContextFiles
    : declaredContextFiles.filter((file) =>
        assembly !== undefined && file.path.startsWith(`${assembly.snapshot.ownWorkspace}/`));
  const customInstructions = buildChatAgentCustomInstructions([
    ...agent.customInstructions,
    ...(workflowContext?.project === undefined ? [] : [{ text: projectContextInstructions(workflowContext.project) }]),
    ...(assembly === undefined ? [] : [{ text: collaborationInstructions(assembly.snapshot) }]),
  ]);
  const pinnedExtensions = options.preparedResourceLoader === undefined ? await validateFrozenAssemblyResources(options.sessionManager, assemblyKey) : undefined;
  const resourceLoader = options.preparedResourceLoader ?? new DefaultResourceLoader({
    cwd,
    agentDir: chatSession.agentDir,
    settingsManager,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: contextFiles.map((file) => ({
      ...file,
      content: assembly === undefined ? file.content : `<chat_context scope="${file.path.startsWith(`${assembly.snapshot.ownWorkspace}/`) ? "agent" : workProject !== undefined && file.path.startsWith(`${workProject.cwd}/`) ? "project" : "personal"}">\n${file.content}\n</chat_context>`,
    })) }),
    ...(scope !== null && !scope.include.personalPromptResources
      ? { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true }
      : agent.resources.mode === "inherit"
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
    ...(scope !== null && !scope.include.personalPromptResources ? {} : agent.resources.mode !== "inherit" ? {} : {
      additionalProjectExtensionPaths: [
        ...(projectResourceDir === undefined ? [] : await projectExtensionPaths(projectResourceDir)),
        ...(assembly === undefined ? [] : await projectExtensionPaths(assembly.snapshot.ownResourceRoot)),
      ],
      additionalPromptTemplatePaths: [
        ...(projectResourceDir === undefined ? [] : [resolve(projectResourceDir, "prompts")]),
        ...(assembly === undefined ? [] : [resolve(assembly.snapshot.ownResourceRoot, "prompts")]),
      ],
    }),
    additionalSkillPaths: [
      ...(scope !== null && !scope.include.personalPromptResources ? [] : agent.resources.mode === "inherit" && projectResourceDir !== undefined
        ? [resolve(projectResourceDir, "skills")]
        : []),
      ...(scope !== null && !scope.include.personalPromptResources ? [] : agent.resources.mode === "inherit" ? [] : agent.resources.skillPaths),
      ...(scope !== null && !scope.include.personalPromptResources ? [] : options.additionalSkillPaths ?? []),
      ...(assembly === undefined || agent.resources.mode !== "inherit" || (scope !== null && !scope.include.personalPromptResources) ? [] : [resolve(assembly.snapshot.ownResourceRoot, "skills")]),
    ],
    ...(pinnedExtensions === undefined ? {} : { noExtensions: true, additionalExtensionPaths: pinnedExtensions, additionalProjectExtensionPaths: [] }),
    ...(replacementSystemPrompt === undefined
      ? {}
      : { systemPromptOverride: () => replacementSystemPrompt }),
    ...(customInstructions === undefined
      ? {}
      : { appendSystemPromptOverride: (base) => [...base, customInstructions] }),
  });
  if (options.preparedResourceLoader === undefined) await resourceLoader.reload();
  if (assembly !== undefined && resourceLoader.getExtensions().errors.length > 0) {
    throw new Error(`Friend扩展装配失败: ${resourceLoader.getExtensions().errors.map((error) => error.error).join("; ")}`);
  }

  const toolAddresses = agent.tools.mode === "none" ? [] : agent.tools.addresses ?? [];
  const scopeCandidates = (() => {
    if (scopeGrants === null || assembly === undefined) return null;
    const nativeTools = agent.tools.mode === "none"
      ? []
      : agent.tools.mode === "explicit"
        ? [...agent.tools.names]
        : settingsManager.getDefaultTools() ?? ["read", "bash", "edit", "write"];
    return { nativeTools: [...new Set([...nativeTools, "read", "write", "edit", "ls", "find", "grep"])], toolAddresses };
  })();
  let chatTools: ResolvedChatTool[] = [];
  // Filled from Pi after assembly, before any Tool can execute.
  const authorizedToolAddresses: string[] = [];
  const authorizedToolNames: string[] = [];
  if (toolAddresses.length > 0) {
    if (chatSession.projectContext === undefined || options.toolContext === undefined) {
      throw new Error(`Agent ${agent.id}配置了Chat系统Tool，但缺少Project或Tool运行上下文`);
    }
    chatTools = resolveChatSystemTools(toolAddresses, {
      ...options.toolContext,
      authorizedToolAddresses,
      authorizedToolNames,
      projectId: chatSession.projectContext.projectId,
      collaborationProjectId: assembly === undefined ? chatSession.projectContext.projectId : assembly.snapshot.projectId,
      chatHome: chatSession.projectContext.chatHome,
      cwd,
      sessionManager: options.sessionManager,
      sessionId: options.sessionManager.getSessionId(),
    });
  }
  const frozenFiles = new Map<string, string>(contextFiles.map((file) => [file.path, file.content]));
  if (assemblyKey !== undefined) {
    const resources = await freezeAssemblyResources({ loader: resourceLoader, manager: options.sessionManager,
      turnId: assemblyKey, persist: options.toolContext?.purpose === "execution", useLoadedSnapshot: options.preparedResourceLoader !== undefined });
    for (const [path, content] of resources) frozenFiles.set(path, content);
  }
  const defaultTools = settingsManager.getDefaultTools() ?? ["read", "bash", "edit", "write"];
  const fileScopeRoot = assembly?.snapshot.ownWorkspace ?? workProject?.projectRoot;
  const applied = scopeCandidates === null ? null : applyScopeToCapabilities(scope, {
    systemTools: chatTools.map((tool) => ({ address: tool.address, name: tool.manifest.name })),
    nativeTools: scopeCandidates.nativeTools,
    extensionTools: [],
  });
  const activeChatTools = applied === null ? chatTools : chatTools.filter((tool) => applied.systemToolNames.includes(tool.manifest.name));
  const guardedTools = fileScopeRoot === undefined || agent.tools.mode === "none" ? [] : scopedFileTools({
    cwd, ownWorkspace: fileScopeRoot, frozenFiles,
    resourceRoots: resourceLoader.getSkills().skills.map((skill) => skill.baseDir),
  }).filter((tool) => agent.tools.mode !== "pi-default" || defaultTools.includes(tool.name));
  const scopedGuarded = applied === null ? guardedTools : guardedTools.filter((tool) => applied.nativeTools.includes(tool.name));
  const scopedInjected = applied === null ? options.customTools ?? [] : (options.customTools ?? []).filter((tool) => applied.nativeTools.includes(tool.name) || applied.extensionTools.includes(tool.name));
  const customTools = [
    ...scopedGuarded,
    ...scopedInjected,
    ...activeChatTools.map((tool) => tool.definition),
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

  if (assembly !== undefined && options.toolContext?.purpose === "execution") {
    persistAssemblySnapshot(options.sessionManager, assembly.snapshot);
  }
  const created = await createAgentSession({
    cwd,
    agentDir: chatSession.agentDir,
    sessionManager: options.sessionManager,
    settingsManager,
    resourceLoader,
    ...(customTools.length === 0 ? {} : { customTools }),
    ...(modelRuntime === undefined ? {} : { modelRuntime }),
    ...(model === undefined ? {} : { model }),
    ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(options.providerRequestGate === undefined ? {} : { providerRequestGate: options.providerRequestGate }),
    ...(applied !== null
      ? (() => {
          const allowedNames = [...new Set([...applied.nativeTools, ...applied.systemToolNames, ...applied.extensionTools])];
          return allowedNames.length === 0
            ? { noTools: "all" as const }
            : { tools: allowedNames, ...(agent.tools.mode === "explicit" ? { excludeTools: [...agent.tools.exclude] } : {}) };
        })()
      : agent.tools.mode === "none"
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

  // UTF-8 bytes are a conservative upper bound, not a provider-specific token count.
  // Reserve Pi's runtime/output allowance; history compaction cannot shrink system rules.
  if (created.session.model !== undefined && created.session.model.contextWindow > 0) {
    const active = new Set(created.session.getActiveToolNames());
    const schemaBytes = Buffer.byteLength(JSON.stringify(created.session.getAllTools().filter((tool) => active.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
    const promptBytes = Buffer.byteLength(created.session.systemPrompt);
    const reserve = settingsManager.getCompactionReserveTokens();
    const budget = Math.max(0, created.session.model.contextWindow - reserve);
    if (promptBytes + schemaBytes > budget) {
      created.session.dispose();
      throw new Error(`Agent必需区域超过安全输入预算（${created.session.model.provider}/${created.session.model.id}，窗口 ${created.session.model.contextWindow}，预留 ${reserve}）：系统提示 ${promptBytes} UTF-8字节，工具Schema ${schemaBytes} 字节，可用 ${budget}；规则文件：${contextFiles.map((file) => `${file.path} (${Buffer.byteLength(file.content)} 字节)`).join(", ")}。请精简配置；不会静默截断规则。`);
    }
  }

  if (agent.tools.mode === "explicit") {
    const available = new Set(created.session.getAllTools().map((tool) => tool.name));
    // Tools the authorization scope excluded are an intersection, not a configuration error.
    const requiredNames = applied === null ? [...agent.tools.names] : agent.tools.names.filter((name) => applied.nativeTools.includes(name) || applied.systemToolNames.includes(name));
    const unknown = [...requiredNames, ...agent.tools.exclude].filter((name) => !available.has(name));
    if (unknown.length > 0) {
      created.session.dispose();
      throw new Error(`Agent配置包含不存在的Tool: ${[...new Set(unknown)].join(", ")}`);
    }
  }

  if (applied !== null) {
    const allowedNames = new Set([...applied.nativeTools, ...applied.systemToolNames, ...applied.extensionTools]);
    const leaked = created.session.getActiveToolNames().filter((name) => !allowedNames.has(name));
    if (leaked.length > 0) {
      created.session.dispose();
      throw new Error(`授权作用域未允许的Tool被注册，已中止本轮：${[...new Set(leaked)].join(", ")}`);
    }
  }
  authorizedToolNames.push(...created.session.getActiveToolNames());
  authorizedToolAddresses.push(...chatTools.filter((tool) => authorizedToolNames.includes(tool.manifest.name)).map((tool) => tool.address));

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
        ...(workProject === undefined ? {} : { projectId: workProject.projectId }),
      }),
      ...(fileVersion?.contentHash === undefined ? {} : { version: fileVersion.contentHash }),
    };
  }));
  if (assemblyKey !== undefined) {
    try {
      freezeAssemblyTools(options.sessionManager, assemblyKey, created.session.getAllTools()
        .filter((tool) => authorizedToolNames.includes(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
          resource: toolResources.find((resource) => resource.name === tool.name) })), options.toolContext?.purpose === "execution");
    } catch (error) {
      created.session.dispose();
      throw error;
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
  return { ...created, resourceLoader, chatTools, toolResources, ...(assembly === undefined ? {} : { assemblySnapshot: assembly.snapshot }) };
}

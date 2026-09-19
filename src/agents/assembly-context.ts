import { resolveResourcePaths } from "../workflows/agent-config-loader.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { SettingsManager, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatSession } from "../chat-session.js";
import { resolveProjectContext } from "../projects/registry.js";
import type { ChatProjectContext } from "../projects/types.js";
import { loadChatAgentContextFiles, type ChatAgentContextFile } from "../workflows/agent-context-files.js";
import { parseWorkflowAgentDefinition, type WorkflowAgentDefinition } from "../workflows/agent-config.js";

export const CHAT_ASSEMBLY_CONTEXT = "chat.agent-assembly.v1";
export const CHAT_COLLABORATION_HISTORY = "chat.collaboration-context.v1";

/** Trusted inputs: callers resolve identity/storage, the common factory resolves work scope. */
export interface ChatAgentInvocation {
  readonly turnId: string;
  readonly ownWorkspace: string;
  readonly ownResourceRoot: string;
  readonly projectId: string | null;
}

export interface ChatAssemblySnapshot {
  readonly schemaVersion: 1;
  readonly turnId: string;
  readonly sessionId: string;
  readonly storageProjectId: string;
  readonly projectId: string | null;
  readonly projectRoot: string | null;
  readonly projectName: string | null;
  readonly projectDescription?: string;
  readonly ownWorkspace: string;
  readonly ownResourceRoot: string;
  readonly cwd: string;
  readonly agent: WorkflowAgentDefinition;
  readonly contextFiles: readonly ChatAgentContextFile[];
  readonly revision: string;
}

export function assemblyRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Workflow already freezes the effective definition; freeze its exact root rules at the same public boundary. */
type AssemblyProject = Pick<ChatProjectContext, "projectId" | "name" | "description" | "projectRoot" | "cwd">;

/** Product identity comes from the selected Project, never from a resource's containing repository. */
export function projectContextInstructions(project: AssemblyProject): string {
  return [
    "<chat_current_project>",
    JSON.stringify(project),
    "This is the user's current project. Its name, purpose and root above are authoritative for this turn. The current working directory belongs to this project.",
    "Unless the user explicitly names another target, 'this project' refers to this declared project. Do not ask the user to identify it again merely because README or other documents are missing.",
    "A parent repository, Chat installation, Agent workspace, or Skill's source directory is not this project. A selected Skill grants access to its resources, not ownership of its containing repository.",
    "Read project documents within the declared root. If documents are absent or unreadable, report that limitation and use the declared project information; do not substitute a parent's README or infer a different project.",
    "Native file tools enforce this scope. Bash, when enabled, remains a trusted host capability, not an OS sandbox.",
    "</chat_current_project>",
  ].join("\n");
}

export async function freezeWorkflowProjectContext(input: {
  readonly manager: SessionManager;
  readonly key: string | undefined;
  readonly projectId: string | undefined;
  readonly agentDir: string;
  readonly projectRoot: string;
  readonly project?: AssemblyProject;
}): Promise<{ files: readonly ChatAgentContextFile[]; project: AssemblyProject | undefined }> {
  const customType = "chat.workflow-context-files.v1";
  const entry = input.key === undefined ? undefined : input.manager.getEntries().findLast((candidate) =>
    candidate.type === "custom" && candidate.customType === customType && record(candidate.data) && candidate.data.key === input.key);
  if (entry?.type === "custom") {
    const value: unknown = entry.data;
    if (!record(value)) throw new Error("Workflow上下文快照损坏");
    const { revision, ...body } = value;
    if (body.schemaVersion !== 1 || body.projectRoot !== input.projectRoot || body.projectId !== input.projectId
      || body.sessionId !== input.manager.getSessionId() || revision !== assemblyRevision(body)
      || !Array.isArray(body.files) || !body.files.every((f: unknown) => record(f) && typeof f.path === "string" && typeof f.content === "string")) {
      throw new Error("Workflow上下文快照归属或内容无效");
    }
    const project = body.project;
    if (project !== undefined && (!record(project) || project.projectId !== input.projectId
      || project.projectRoot !== input.projectRoot || project.cwd !== input.project?.cwd
      || typeof project.name !== "string" || typeof project.description !== "string")) {
      throw new Error("Workflow项目身份快照无效");
    }
    // Older snapshots froze rules only; retain them and use the resolved identity without rewriting history.
    return { files: body.files as ChatAgentContextFile[], project: project === undefined ? input.project : project as AssemblyProject };
  }
  const files = await loadChatAgentContextFiles(input);
  if (input.key !== undefined) {
    const body = { schemaVersion: 1, key: input.key, projectId: input.projectId, projectRoot: input.projectRoot,
      sessionId: input.manager.getSessionId(), files, ...(input.project === undefined ? {} : { project: input.project }) };
    input.manager.appendCustomEntry(customType, { ...body, revision: assemblyRevision(body) });
    input.manager.flush();
  }
  return { files, project: input.project };
}

/** Personal defaults, without project settings or model restoration from yesterday's Session. */
export function personalAgentSettings(agentDir: string): SettingsManager {
  const settings = SettingsManager.fromStorage({
    withLock: (scope, update) => {
      let content: string | undefined;
      if (scope === "global") {
        try { content = readFileSync(join(agentDir, "settings.json"), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      update(content);
    },
  });
  const errors = settings.drainErrors();
  if (errors.length > 0) throw new Error("无法读取 Personal Agent 设置", { cause: errors[0]?.error });
  return SettingsManager.inMemory(settings.getGlobalSettings());
}

export function resolvePersonalAgentDefinition(agent: WorkflowAgentDefinition, settings: SettingsManager): WorkflowAgentDefinition {
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  const model = agent.model ?? (provider !== undefined && modelId !== undefined ? { provider, modelId } : undefined);
  const thinkingLevel = agent.thinkingLevel ?? settings.getDefaultThinkingLevel() ?? "off";
  return { ...agent, ...(model === undefined ? {} : { model }), thinkingLevel };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native CustomEntry is a durable audit/snapshot, never a second transcript. */
export function readAssemblySnapshot(manager: SessionManager, turnId: string): ChatAssemblySnapshot | undefined {
  for (const entry of manager.getEntries().toReversed()) {
    if (entry.type !== "custom" || entry.customType !== CHAT_ASSEMBLY_CONTEXT) continue;
    const value: unknown = entry.data;
    if (!record(value)) throw new Error("Agent装配快照损坏");
    if (value.turnId !== turnId) continue;
    const { revision, ...body } = value;
    if (body.schemaVersion !== 1 || revision !== assemblyRevision(body)
      || ![body.turnId, body.sessionId, body.storageProjectId, body.ownWorkspace, body.ownResourceRoot, body.cwd].every((v) => typeof v === "string" && v !== "")
      || ![body.projectId, body.projectRoot, body.projectName].every((v) => v === null || typeof v === "string")
      || (body.projectDescription !== undefined && typeof body.projectDescription !== "string")
      || !Array.isArray(body.contextFiles)
      || !body.contextFiles.every((v: unknown) => record(v) && typeof v.path === "string" && typeof v.content === "string")) {
      throw new Error("Agent装配快照版本、内容或校验和无效");
    }
    parseWorkflowAgentDefinition(body.agent);
    return value as unknown as ChatAssemblySnapshot;
  }
  return undefined;
}

export async function resolveChatAssemblyContext(input: {
  readonly chatSession: ChatSession;
  readonly sessionManager: SessionManager;
  readonly agent: WorkflowAgentDefinition;
  readonly invocation: ChatAgentInvocation;
}) {
  const { chatSession, sessionManager, invocation } = input;
  const storage = chatSession.projectContext;
  if (storage === undefined) throw new Error("Agent装配缺少Session存储归属");
  const saved = readAssemblySnapshot(sessionManager, invocation.turnId);
  const projectId = saved?.projectId === undefined ? invocation.projectId : saved.projectId;
  const project: ChatProjectContext | null = projectId === null ? null : await resolveProjectContext(projectId, storage.chatHome);
  if (project !== null && project.kind !== "project") throw new Error("协作上下文必须是用户项目，不能是Agent空间");
  const ownWorkspace = await realpath(invocation.ownWorkspace);
  const ownResourceRoot = await realpath(invocation.ownResourceRoot);
  const cwd = project?.cwd ?? ownWorkspace;
  const personalSettings = personalAgentSettings(chatSession.agentDir);
  const settingsManager = SettingsManager.create(cwd, chatSession.agentDir);
  if (settingsManager.drainErrors().length > 0) throw new Error("无法读取本轮项目资源设置");
  if (saved !== undefined) {
    if (saved.sessionId !== sessionManager.getSessionId() || saved.storageProjectId !== storage.projectId
      || saved.agent.id !== input.agent.id || saved.ownWorkspace !== ownWorkspace
      || saved.ownResourceRoot !== ownResourceRoot || saved.cwd !== cwd || saved.projectRoot !== (project?.projectRoot ?? null)) {
      throw new Error("Agent装配快照的身份或已授权路径发生变化，不能恢复本轮");
    }
    return { snapshot: saved, project, settingsManager };
  }
  const contextFiles = await loadChatAgentContextFiles({
    agentDir: chatSession.agentDir, ownRoot: ownWorkspace,
    ...(project === null ? {} : { projectRoot: project.projectRoot }),
  });
  const definition = resolvePersonalAgentDefinition(input.agent, personalSettings);
  const agent = { ...definition, resources: await resolveResourcePaths(definition.resources,
    join(ownResourceRoot, "definition.json"), new Set([ownResourceRoot, cwd, await realpath(chatSession.agentDir)])) };
  if (agent.model === undefined) throw new Error("Friend需要在自身定义或Personal设置中配置模型");
  const body = {
    schemaVersion: 1 as const, turnId: invocation.turnId, sessionId: sessionManager.getSessionId(),
    storageProjectId: storage.projectId, projectId, projectRoot: project?.projectRoot ?? null,
    projectName: project?.name ?? null, projectDescription: project?.description ?? "", ownWorkspace, ownResourceRoot, cwd, agent, contextFiles,
  };
  return { snapshot: { ...body, revision: assemblyRevision(body) }, project, settingsManager };
}

export function collaborationInstructions(snapshot: ChatAssemblySnapshot): string {
  return [
    "<chat_project_collaboration>",
    `Your stable Agent workspace is ${snapshot.ownWorkspace}. It stores your own work and is not the user's project.`,
    snapshot.projectId === null
      ? "No user project is selected for this turn. Work in your own workspace; Project Memory requires an explicit target."
      : projectContextInstructions({ projectId: snapshot.projectId, name: snapshot.projectName ?? snapshot.projectId,
          description: snapshot.projectDescription ?? "", projectRoot: snapshot.projectRoot ?? snapshot.cwd, cwd: snapshot.cwd }),
    "The current system context files govern this turn. Earlier project labels and rules in conversation history are historical facts, not current instructions. A later user message may select a different project without changing your identity or this conversation.",
    "Personal rules, your workspace rules, and current project rules below have separate scopes. File tools enforce the declared paths; bash, if enabled, is a trusted host capability, not a sandbox.",
    "</chat_project_collaboration>",
  ].join("\n");
}

export function persistAssemblySnapshot(manager: SessionManager, snapshot: ChatAssemblySnapshot): void {
  if (readAssemblySnapshot(manager, snapshot.turnId) !== undefined) return;
  manager.appendCustomEntry(CHAT_ASSEMBLY_CONTEXT, snapshot);
  const previous = manager.getEntries().slice(0, -1).findLast((entry) => entry.type === "custom" && entry.customType === CHAT_ASSEMBLY_CONTEXT);
  const previousData: unknown = previous?.type === "custom" ? previous.data : undefined;
  if (!record(previousData) || previousData.projectId !== snapshot.projectId) manager.appendCustomMessageEntry(CHAT_COLLABORATION_HISTORY,
    `Historical turn context: ${snapshot.turnId}; collaboration project: ${snapshot.projectName ?? "none"} (${snapshot.projectId ?? "none"}). This labels the following work, not current instructions.`, false);
  manager.flush();
}

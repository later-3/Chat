import { ensureChannelMessagingSkill } from "./resources/channel-messaging-skill.js";
import { ensureLongAgentManagementSkill } from "./resources/long-agent-management-skill.js";
import { ensureProjectManagementSkill } from "./resources/project-management-skill.js";
import { resolve } from "node:path";
import { ensureChatHome, resolveChatHome } from "./chat-home.js";
import { migrateLegacyProjectLayout } from "./migrations/project-layout-v1.js";
import { ensureMemorySkill } from "./workflows/memory/agents/memory-agent/skill.js";
import { ensureWorkflowDelegationSkill } from "./workflows/planner-orchestrator/agents/coordinator/skill.js";
import { ensureRuleLibrarySkill } from "./workflows/rule-management/agents/rule-curator-agent/skill.js";
import { purgeExpiredRemovedSessionsAcrossProjects } from "./session-removal.js";
import { registerChatWorkflowCallRuntime } from "./workflows/workflow-call-runtime.js";
import { ensureDailyProject } from "./projects/registry.js";
import { startLongAgentSync } from "./long-agents/bridge.js";

const initializations = new Map<string, Promise<void>>();

/** Initializes the local Chat control plane once before serving requests. */
export function ensureChatRuntimeInitialized(options: {
  readonly projectRoot?: string;
  readonly chatHome?: string;
} = {}): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const chatHome = resolveChatHome(options.chatHome);
  const key = `${chatHome}\0${projectRoot}`;
  const existing = initializations.get(key);
  if (existing !== undefined) return existing;
  // Keep the Backend dispatcher outside the static Pi Tool graph. Besides
  // preserving the Workflow/Step boundary, the lazy edge avoids initialization
  // cycles between Chat config, the registry, and Nitro's generated module init.
  const initialized = import("./workflows/workflow-call.js")
    .then(({ CHAT_WORKFLOW_CALL_RUNTIME }) => {
      registerChatWorkflowCallRuntime(CHAT_WORKFLOW_CALL_RUNTIME);
      return migrateLegacyProjectLayout({ projectRoot, chatHome });
    })
    .then(async () => {
      const paths = await ensureChatHome(chatHome);
      await Promise.all([
        ensureDailyProject(paths.root),
        ensureProjectManagementSkill(paths.root),
        ensureLongAgentManagementSkill(paths.root),
        ensureChannelMessagingSkill(paths.root),
        ensureMemorySkill(paths.runtimeDir, { refresh: true }),
        ensureWorkflowDelegationSkill(paths.runtimeDir, { refresh: true }),
        ensureRuleLibrarySkill(paths.runtimeDir, { refresh: true }),
        purgeExpiredRemovedSessionsAcrossProjects(paths.root),
      ]);
      // S3/S4 启动时全量迁移：每个 Agent 的独立配置根与 Daily Project 一次性就绪，
      // 不做依赖入口的懒迁移，避免通道绑定继续路由到共享 daily 的旧会话。
      const { readLongAgentRegistry, ensureLongAgentResourceDirs } = await import("./long-agents/storage.js");
      const { ensureLongAgentDailyProject } = await import("./long-agents/daily-project.js");
      const longAgentRegistry = await readLongAgentRegistry(paths.root);
      for (const agent of longAgentRegistry.agents) {
        await ensureLongAgentResourceDirs(paths.root, agent.id);
        await ensureLongAgentDailyProject(agent, paths.root);
      }
      startLongAgentSync(paths.root);
    })
    .catch((error: unknown) => {
      initializations.delete(key);
      throw error;
    });
  initializations.set(key, initialized);
  return initialized;
}

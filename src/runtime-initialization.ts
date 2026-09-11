import { ensureChannelMessagingSkill } from "./resources/channel-messaging-skill.js";
import { ensureTaskSchedulingSkill } from "./resources/task-scheduling-skill.js";
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
import { ensureLongAgentShareProject } from "./projects/registry.js";
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
        ensureLongAgentShareProject(paths.root),
        ensureProjectManagementSkill(paths.root),
        ensureLongAgentManagementSkill(paths.root),
        ensureChannelMessagingSkill(paths.root),
        ensureTaskSchedulingSkill(paths.root),
        ensureMemorySkill(paths.runtimeDir, { refresh: true }),
        ensureWorkflowDelegationSkill(paths.runtimeDir, { refresh: true }),
        ensureRuleLibrarySkill(paths.runtimeDir, { refresh: true }),
        purgeExpiredRemovedSessionsAcrossProjects(paths.root),
      ]);
      // 归一迁移（幂等，带备份与完成标记）：Agent 日常项目并入自己的根、
      // 共享 daily 改名为 longagentshare、Agent 历史会话迁回各自 Agent。
      const { migrateAgentHomeNormalization, sweepLegacyAgentProjectDirs } = await import("./migrations/agent-home-normalization.js");
      await migrateAgentHomeNormalization(paths.root);
      await sweepLegacyAgentProjectDirs(paths.root);
      // 启动时确保每个 Agent 的配置根与资源目录就绪。
      const { readLongAgentRegistry, ensureLongAgentResourceDirs } = await import("./long-agents/storage.js");
      const { reconcileDefaultLongAgentTools } = await import("./long-agents/definition-defaults.js");
      await reconcileDefaultLongAgentTools(paths.root);
      const { ensureDefaultLongAgentTasks } = await import("./long-agents/agent-tasks.js");
      const longAgentRegistry = await readLongAgentRegistry(paths.root);
      for (const agent of longAgentRegistry.agents) {
        await ensureLongAgentResourceDirs(paths.root, agent.id);
        // 预置的两个日常任务（幂等）。NanoClaw 不可用时只记录，不阻塞 Chat 启动。
        const instance = longAgentRegistry.instances.find((candidate) => candidate.id === agent.instanceId);
        if (instance === undefined || !agent.enabled) continue;
        try {
          await ensureDefaultLongAgentTasks({ instance, agentGroupId: agent.nanoclawAgentGroupId });
        } catch (error) {
          console.warn(`预置Long Agent任务失败（${agent.id}）: ${error instanceof Error ? error.message : String(error)}`);
        }
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

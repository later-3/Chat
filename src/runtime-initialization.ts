import { ensureChannelMessagingSkill } from "./resources/channel-messaging-skill.js";
import { ensureDeliverablesSkill, ensureDutyManagementSkill, ensureTaskSchedulingSkill } from "./resources/builtin-personal-skill.js";
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
import { registerTopicCreationRuntime } from "./workflows/topic-creation-runtime.js";
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
      const { startTopicSessionCreation } = await import("./workflows/topic-session-create/start.js");
      registerTopicCreationRuntime({ start: startTopicSessionCreation });
    })
    .then(async () => {
      const paths = await ensureChatHome(chatHome);
      await Promise.all([
        ensureLongAgentShareProject(paths.root),
        ensureProjectManagementSkill(paths.root),
        ensureLongAgentManagementSkill(paths.root),
        ensureChannelMessagingSkill(paths.root),
        ensureTaskSchedulingSkill(paths.root),
        ensureDutyManagementSkill(paths.root),
        ensureDeliverablesSkill(paths.root),
        ensureMemorySkill(paths.runtimeDir, { refresh: true }),
        ensureWorkflowDelegationSkill(paths.runtimeDir, { refresh: true }),
        ensureRuleLibrarySkill(paths.runtimeDir, { refresh: true }),
        purgeExpiredRemovedSessionsAcrossProjects(paths.root),
      ]);
      // 无损建立 Agent Home；保留旧项目/历史/渠道来源，不创建空的每日 Session。
      const { migrateAgentHomeNormalization } = await import("./migrations/agent-home-normalization.js");
      await migrateAgentHomeNormalization(paths.root);
      // 启动时确保每个 Agent 的配置根与资源目录就绪。
      const { readLongAgentRegistry, ensureLongAgentResourceDirs } = await import("./long-agents/storage.js");
      const { reconcileDefaultLongAgentTools } = await import("./long-agents/definition-defaults.js");
      await reconcileDefaultLongAgentTools(paths.root);
      for (const agent of (await readLongAgentRegistry(paths.root)).agents) {
        await ensureLongAgentResourceDirs(paths.root, agent.id);
      }
      const { startLongAgentDailyMaintenance } = await import("./long-agents/daily-maintenance.js");
      startLongAgentDailyMaintenance(paths.root);
      startLongAgentSync(paths.root);
      // Group state: a `running` speech that lost its terminal state becomes `interrupted` and is
      // never replayed; queued attempts/tasks are safe to resume in the background.
      const { recoverConversationsOnStartup } = await import("./long-agents/conversations/recovery.js");
      await recoverConversationsOnStartup(paths.root).catch((error: unknown) => {
        console.error("群状态启动恢复失败", error instanceof Error ? error.message : String(error));
      });
    })
    .catch((error: unknown) => {
      initializations.delete(key);
      throw error;
    });
  initializations.set(key, initialized);
  return initialized;
}

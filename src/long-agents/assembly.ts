import { ensureAgentCalendar } from "./project-agent.js";
import { DAILY_ARCHIVE_INSTRUCTIONS } from "./daily-summary-task.js";
import { agentDate } from "./calendar.js";
import { ensureAgentHomeProject, resolveProjectContext } from "../projects/registry.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot } from "./storage.js";
import { buildAgentGroupContextInstructions, readLongAgentAgentGroup, type readFrozenLongAgentAgentGroup } from "./agent-group-service.js";
import { buildReplyFormatInstruction, localDate } from "./reply-template.js";
import { buildLongAgentHandoff } from "./summaries.js";
import { longAgentScopeInstructions, type LongAgentScope } from "./scope.js";
import type { LongAgentConfig } from "./types.js";

/** Lifecycle and inspection share Friend-owned inputs; public assembly owns project rules/tools/settings. */
export async function prepareLongAgentAssembly(input: {
  readonly agent: LongAgentConfig;
  readonly chatHome: string;
  readonly projectId: string | null;
  readonly turnId: string;
  readonly today?: string;
  readonly groupContext?: Awaited<ReturnType<typeof readFrozenLongAgentAgentGroup>>;
  /**
   * Backend-resolved authorization scope for this turn. Omitted callers keep the established direct
   * behaviour; a conversation scope excludes private injections and non-authorized tools by default.
   */
  readonly scope?: LongAgentScope;
  /** Grants commitment from the trusted record; produced together with `scope`. */
  readonly scopeGrantsDigest?: string;
}) {
  const { chatHome } = input;
  const agent = await ensureAgentCalendar(input.agent, chatHome);
  const own = await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  await ensureLongAgentResourceDirs(chatHome, agent.id);
  const project = input.projectId === null ? null : await resolveProjectContext(input.projectId, chatHome);
  const scope = input.scope;
  const includeGroup = scope === undefined || scope.include.agentGroupInstructions;
  const includeHandoff = scope === undefined || scope.include.dailyHandoff;
  const group = includeGroup ? input.groupContext ?? await readLongAgentAgentGroup(agent.id, chatHome) : undefined;
  const handoff = includeHandoff
    ? await buildLongAgentHandoff({ chatHome, longAgentId: agent.id, today: input.today ?? agentDate(agent.timeZone) })
    : null;
  const format = buildReplyFormatInstruction(agent.responseTemplate, {
    project: project?.name ?? "无项目", agentName: agent.name, date: input.today ?? localDate(),
  });
  return {
    invocation: {
      turnId: input.turnId, projectId: input.projectId,
      ownWorkspace: own.cwd, ownResourceRoot: longAgentConfigRoot(chatHome, agent.id),
      ...(scope === undefined ? {} : { scope, ...(input.scopeGrantsDigest === undefined ? {} : { scopeGrantsDigest: input.scopeGrantsDigest }) }),
    },
    agent: {
      ...agent.definition,
      customInstructions: [
        ...agent.definition.customInstructions,
        ...(group === undefined ? [] : [{ text: buildAgentGroupContextInstructions(group) }]),
        ...(format === null ? [] : [{ text: format }]),
        ...(includeHandoff ? [{ text: DAILY_ARCHIVE_INSTRUCTIONS }] : []),
        ...(handoff === null ? [] : [{ text: handoff }]),
        ...(scope === undefined ? [] : [{ text: longAgentScopeInstructions(scope, { agentName: agent.name }) }]),
        { text: "<chat_runtime_capability_contract>你是由 Chat 公共 Pi 装配执行的长期助手。当前 Agent、Project、Session 与授权范围由本轮服务端上下文确定。平台能力以本轮实际激活的 Tool 名称、Schema 和使用说明为准；身份职责、旧记忆或历史中的功能上线状态和容器路径不能覆盖当前能力事实。工具已提供表示允许尝试，不表示网关或外部服务必然可达；失败须报告真实原因，不能说成记忆不存在。NanoClaw Agent Memory 通过 agent_memory_* 访问，不能猜测其宿主或原生容器路径；Chat Personal/Project 共享事实用 memory_*，会话要点用 session_memory，每日总结和历史归档用 summary_manage。只使用本轮存在的工具，未提供则明确说明能力未装配；不要修改身份定义或扩大权限来绕过。身份和职责仍沿用已配置来源。</chat_runtime_capability_contract>" },
      ],
    },
  };
}

import type { AgentInstruction, WorkflowAgentDefinition } from "../workflows/agent-config.js";
import { resolveLongAgentWorkflowAgent } from "./workflow-configuration.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { DAILY_ARCHIVE_INSTRUCTIONS } from "./daily-summary-task.js";
import { agentDate } from "./calendar.js";
import { ensureAgentHomeProject } from "../projects/registry.js";
import { hasInteractionHarness, interactionHarnessInstruction, readInteractionHarness } from "./interaction-harness.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot } from "./storage.js";
import { buildAgentGroupContextSections, readLongAgentAgentGroup, type readFrozenLongAgentAgentGroup } from "./agent-group-service.js";
import { buildLongAgentHandoff } from "./summaries.js";
import { longAgentScopeInstructions, type LongAgentScope } from "./scope.js";
import type { LongAgentConfig } from "./types.js";

/** Lifecycle and inspection share Friend-owned inputs; public assembly owns project rules/tools/settings. */
export async function prepareLongAgentAssembly(input: {
  readonly agent: LongAgentConfig;
  readonly executionAgent?: WorkflowAgentDefinition;
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
  const scope = input.scope;
  const includeGroup = scope === undefined || scope.include.agentGroupInstructions;
  const includeHandoff = scope === undefined || scope.include.dailyHandoff;
  const group = includeGroup ? input.groupContext ?? await readLongAgentAgentGroup(agent.id, chatHome) : undefined;
  const handoff = includeHandoff
    ? await buildLongAgentHandoff({ chatHome, longAgentId: agent.id, today: input.today ?? agentDate(agent.timeZone) })
    : null;
  const execution = input.executionAgent ?? (scope === undefined
    ? (await resolveLongAgentWorkflowAgent(agent, chatHome)).agent : agent.definition);
  const identityInstructions = [
    ...(agent.definition.systemPrompt.mode === "replace" ? [{ text: agent.definition.systemPrompt.text }] : []),
    ...agent.definition.customInstructions,
  ];
  // 交互 harness 是一套规则：通用规范对所有 Long Agent 生效，项目专属规范仅在该 (agent, project) 下生效。
  const harness = await readInteractionHarness({ chatHome, longAgentId: agent.id, projectId: input.projectId });
  const harnessInstruction = hasInteractionHarness(harness) ? interactionHarnessInstruction(harness) : undefined;
  const prepared = {
    invocation: {
      turnId: input.turnId, projectId: input.projectId,
      ownWorkspace: own.cwd, ownResourceRoot: longAgentConfigRoot(chatHome, agent.id),
      ...(scope === undefined ? {} : { scope, ...(input.scopeGrantsDigest === undefined ? {} : { scopeGrantsDigest: input.scopeGrantsDigest }) }),
    },
    agent: {
      schemaVersion: execution.schemaVersion, id: execution.id, name: execution.name, description: execution.description,
      ...(execution.model === undefined ? {} : { model: execution.model }),
      ...(execution.thinkingLevel === undefined ? {} : { thinkingLevel: execution.thinkingLevel }),
      systemPrompt: execution.systemPrompt, tools: execution.tools, resources: execution.resources,
      customInstructions: [
        ...execution.customInstructions,
        ...(execution === agent.definition ? [] : identityInstructions),
        ...(group === undefined ? [] : buildAgentGroupContextSections(group).map((text): AgentInstruction => ({ text }))),
        ...(includeHandoff ? [{ text: DAILY_ARCHIVE_INSTRUCTIONS }] : []),
        ...(handoff === null ? [] : [{ text: handoff }]),
        ...(scope === undefined ? [] : [{ text: longAgentScopeInstructions(scope, { agentName: agent.name }) }]),
        { text: "<memory_fact_contract>记忆只保存有依据的事实：用户明确说过的内容才可归为 user，Agent 的推断须单独归为 agent 并标明不确定性；计划、尝试、成功分别表述，只有真实成功回执才能声称已完成，不把尚未发送的回复记为已回复。Session、轮次、请求、原生消息 Entry 和记忆条目是不同标识，来源以工具和服务端上下文为准，禁止互换。发现旧事实错误时以可追踪修订纠正，不覆盖用户原始发言。</memory_fact_contract>" },
        ...(harnessInstruction === undefined ? [] : [{ text: harnessInstruction }]),
        { text: "<chat_runtime_capability_contract>你是由 Chat 公共 Pi 装配执行的长期助手。当前 Agent、Project、Session 与授权范围由本轮服务端上下文确定。平台能力以本轮实际激活的 Tool 名称、Schema 和使用说明为准；身份职责、旧记忆或历史中的功能上线状态和容器路径不能覆盖当前能力事实。工具已提供表示允许尝试，不表示网关或外部服务必然可达；失败须报告真实原因，不能说成记忆不存在。NanoClaw Agent Memory 通过 agent_memory_* 访问，不能猜测其宿主或原生容器路径；Chat Personal/Project 共享事实用 memory_*，会话要点用 session_memory，每日总结和历史归档用 summary_manage。只使用本轮存在的工具，未提供则明确说明能力未装配；不要修改身份定义或扩大权限来绕过。身份和职责仍沿用已配置来源。</chat_runtime_capability_contract>" },
      ],
    },
  };
  return { ...prepared, identityInstructions: prepared.agent.customInstructions.slice(execution.customInstructions.length) };
}

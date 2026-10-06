import type { AgentInstruction, WorkflowAgentDefinition } from "../workflows/agent-config.js";
import type { LongAgentAgentGroupDocument } from "./agent-group-service.js";
import { resolveLongAgentWorkflowAgent } from "./workflow-configuration.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { DAILY_ARCHIVE_INSTRUCTIONS } from "./daily-summary-task.js";
import { agentDate } from "./calendar.js";
import { ensureAgentHomeProject } from "../projects/registry.js";
import { hasInteractionHarness, interactionHarnessInstruction, readInteractionHarness } from "./interaction-harness.js";
import { ensureLongAgentResourceDirs, longAgentConfigRoot } from "./storage.js";
import { buildAgentMemorySection, buildNanoClawIdentityOverride, readLongAgentAgentGroup, type readFrozenLongAgentAgentGroup } from "./agent-group-service.js";
import { NanoClawGatewayUnavailableError } from "./nanoclaw-client.js";
import { buildLongAgentHandoff } from "./summaries.js";
import { longAgentScopeInstructions, type LongAgentScope } from "./scope.js";
import type { LongAgentConfig } from "./types.js";

/** Lifecycle and inspection share Friend-owned inputs; public assembly owns project rules/tools/settings. */
/**
 * 构成层 · 身份区域：由 **Chat 的 Agent 定义**生成（名称、简介、身份指令），
 * NanoClaw 的 Agent Group 若可用则作为覆盖片段附在同一区域内。NanoClaw 不可用时身份依然完整。
 */
function buildChatIdentityInstruction(
  agent: LongAgentConfig,
  group: LongAgentAgentGroupDocument | undefined,
): string {
  const override = group === undefined ? undefined : buildNanoClawIdentityOverride(group);
  return [
    '<chat_identity source="chat">',
    `<runtime_identity_name>${agent.name}</runtime_identity_name>`,
    agent.description.trim() === "" ? "" : `<runtime_identity_summary>${agent.description.trim()}</runtime_identity_summary>`,
    agent.definition.systemPrompt.mode === "replace" && agent.definition.systemPrompt.text.trim() !== ""
      ? `<runtime_identity_instructions>\n${agent.definition.systemPrompt.text.trim()}\n</runtime_identity_instructions>`
      : "",
    override === undefined ? "" : override,
    "</chat_identity>",
  ].filter((line) => line !== "").join("\n");
}

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
  // 降级契约：NanoClaw 不可用（网关不可达/无快照）时，装配照常进行——身份由 Chat 的 Agent 定义提供，
  // 身份覆盖与长期记忆区域为空；只有快照本身损坏等真实错误才向上抛。
  const group = includeGroup
    ? input.groupContext ?? await readLongAgentAgentGroup(agent.id, chatHome).catch((error: unknown) => {
        if (error instanceof NanoClawGatewayUnavailableError) return undefined;
        throw error;
      })
    : undefined;
  const handoff = includeHandoff
    ? await buildLongAgentHandoff({ chatHome, longAgentId: agent.id, today: input.today ?? agentDate(agent.timeZone) })
    : null;
  const execution = input.executionAgent ?? (scope === undefined
    ? (await resolveLongAgentWorkflowAgent(agent, chatHome)).agent : agent.definition);
  const identityInstructions = [
    ...(agent.definition.systemPrompt.mode === "replace" ? [{ text: agent.definition.systemPrompt.text }] : []),
    ...agent.definition.customInstructions,
  ];
  // 交互 harness 是一套规则：通用规范对所有 Long Agent 生效，项目专属规范仅在该 (agent, project) 下生效；
  // 开关在 Agent 配置层（缺省 on）。
  const harnessEnabled = agent.interactionHarness !== "off";
  const harness = harnessEnabled
    ? await readInteractionHarness({ chatHome, longAgentId: agent.id, projectId: input.projectId })
    : undefined;
  const harnessInstruction = harness !== undefined && hasInteractionHarness(harness)
    ? interactionHarnessInstruction(harness)
    : undefined;
  // 构成层 · 身份：Chat 的 Agent 定义为主身份；NanoClaw 的 Agent Group 只作为可选覆盖。
  const identityInstruction = buildChatIdentityInstruction(agent, group);
  // 构成层 · 长期记忆：Agent Memory 为可选来源，受开关控制（关闭只影响注入）。
  const memoryInstruction = group === undefined || agent.agentMemory === "off"
    ? undefined
    : buildAgentMemorySection(group);
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
        { text: identityInstruction },
        ...(memoryInstruction === undefined ? [] : [{ text: memoryInstruction }]),
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

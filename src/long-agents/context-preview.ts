/**
 * B5 发送前预览（用户 2026-10-13 定界）：
 * 预览必须是**"这一次将发送的内容"**，而不是回看上一次已发送的请求。
 *
 * 做法：用当前会话、Agent 与 Workflow 配置**真实装配**一份请求（与真实发送走同一条装配链：
 * prepareLongAgentAssembly → createChatPiAgentSession），读回 Pi 实际生成的
 * system prompt、工具 schema 与会话上下文消息，再拼上用户正在输入的草稿。
 * **不调用模型、不落盘**（装配与工具快照写在 in-memory Session 里，同 turn-queue 既有做法）。
 */
import { randomUUID } from "node:crypto";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { createChatPiAgentSession } from "../agents/pi-agent-session.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflows/workflow-configuration.js";
import { prepareLongAgentAssembly } from "./assembly.js";
import { readLongAgentAgentGroup } from "./agent-group-service.js";
import { readLongAgentRegistry } from "./storage.js";
import { longAgentWorkflowConfiguration } from "./workflow-configuration.js";
import { applyContextEdit, readContextEditFromEntries } from "../context-edit.js";
import { parseProviderPayloadRegions } from "../session-prompt-capture.js";

export interface SendPreviewTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface SendPreview {
  /** 完整请求体（已应用编辑层：与真实发送同一过滤函数——所见即所发）。 */
  readonly payload: {
    readonly model: string;
    /** Pi `convertToLlm` 的输出（user/assistant/toolResult，保留全部 parts 与字段）。 */
    readonly messages: readonly Record<string, unknown>[];
    readonly tools: readonly { readonly type: "function"; readonly function: { readonly name: string; readonly description?: string; readonly parameters?: unknown } }[];
  };
  readonly excludedCount: number;
  /** 消息区域分类（与真实详情同一解析器）。 */
  readonly messageRegions?: readonly { readonly index: number; readonly role: string; readonly region: string; readonly customType?: string; readonly timestamp?: number }[];
  readonly systemPrompt: string;
  readonly tools: readonly SendPreviewTool[];
  readonly messages: readonly Record<string, unknown>[];
  readonly model: { readonly provider: string; readonly modelId: string };
}

export async function buildSendPreview(input: {
  readonly chatHome?: string;
  readonly projectId: string;
  /** 当前对话所在项目（Agent 容器为 null）；协作上下文只允许用户项目，不能是 Agent 空间。 */
  readonly contextProjectId?: string | null;
  readonly sessionId: string;
  readonly longAgentId: string;
  readonly draft?: string;
}): Promise<SendPreview> {
  const home = resolveChatHome(input.chatHome);
  const agent = (await readLongAgentRegistry(home)).agents
    .find((candidate) => candidate.id === input.longAgentId && candidate.enabled && candidate.status !== "archived");
  if (agent === undefined) throw new Error(`找不到可用LongAgent: ${input.longAgentId}`);
  const chatSession = await openChatSession({
    projectId: input.projectId, chatHome: home, sessionId: input.sessionId, ownerLongAgentId: agent.id,
  });
  // 临时 Session 只为装配预览（与 turn-queue 同一做法）：custom 快照复制进去，不写真实会话文件。
  const memory = SessionManager.inMemory(chatSession.cwd);
  for (const entry of chatSession.manager.getEntries()) {
    if (entry.type === "custom") memory.appendCustomEntry(entry.customType, entry.data);
  }
  const configured = await longAgentWorkflowConfiguration(agent, home);
  const workflowInvocationId = randomUUID();
  const workflowAgents = await prepareChatWorkflowTurnConfiguration(memory, {
    invocationId: workflowInvocationId,
    workflowId: configured.workflow.id,
    agents: configured.workflow.agents,
    cwd: configured.project.cwd,
    chatHome: home,
    projectDataDir: configured.project.projectDataDir,
    ...(configured.defaults === undefined ? {} : { defaults: configured.defaults }),
  });
  const primary = configured.workflow.agents[0];
  if (primary === undefined) throw new Error("Workflow缺少执行Agent");
  const executionAgent = workflowAgents.agents[primary.id];
  if (executionAgent === undefined) throw new Error("Workflow缺少冻结执行Agent");
  const turnId = `preview:${agent.id}:${randomUUID()}`;
  const group = await readLongAgentAgentGroup(agent.id, home);
  const prepared = await prepareLongAgentAssembly({
    agent, chatHome: home, projectId: input.contextProjectId ?? null, turnId, executionAgent, groupContext: group,
  });
  memory.appendCustomEntry("chat.agent-assembly-identity.v1", { turnId, instructions: prepared.identityInstructions });
  const created = await createChatPiAgentSession({
    chatSession, sessionManager: memory, ...prepared,
    toolContext: {
      purpose: "execution",
      agentId: executionAgent.id,
      longAgentId: agent.id,
      longAgentTurnId: turnId,
      workflowId: configured.workflow.id,
      workflowInvocationId,
      stageId: configured.workflow.nodes.find((node) => node.kind === "agent" && node.agentId === executionAgent.id)?.id ?? executionAgent.id,
    },
  });
  const session = created.session;
  const contextMessages = chatSession.manager.buildSessionContext().messages;
  const messages = [
    { role: "system", content: session.systemPrompt },
    // 走 Pi 交给 provider 的同一转换（convertToLlm）：完整保留 assistant 的 content parts
    // （text / thinking / toolCall）与 toolResult，不做自己的“近似映射”（provider 编码细节——
    // 如 tool_calls / reasoning_content / tool_call_id——由适配器完成，界面已注明）。
    ...convertToLlm(contextMessages).map((message) => message as unknown as Record<string, unknown>),
    ...(input.draft === undefined || input.draft.trim() === "" ? [] : [{ role: "user", content: input.draft }]),
  ];
  const tools: SendPreviewTool[] = (session.agent.state.tools ?? []).map((tool) => {
    const record = tool as { name?: unknown; description?: unknown; parameters?: unknown };
    return {
      name: typeof record.name === "string" ? record.name : "?",
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(record.parameters === undefined ? {} : { parameters: record.parameters }),
    };
  });
  const model = session.model;
  // 与真实发送一致：先构造完整请求体，再跑**同一个编辑层过滤函数**（所见即所发）。
  const rawPayload = {
    model: `${model?.provider ?? ""}/${model?.id ?? ""}`,
    messages: [
      { role: "system", content: session.systemPrompt },
      // 同一转换（与 :100 一致）——预览与真实发送共用 Pi 的 convertToLlm。
      ...convertToLlm(contextMessages).map((message) => message as unknown as Record<string, unknown>),
      ...(input.draft === undefined || input.draft.trim() === "" ? [] : [{ role: "user", content: input.draft }]),
    ],
    tools: tools.map((tool) => ({
      type: "function" as const,
      function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }) },
    })),
  };
  const editLayer = readContextEditFromEntries(chatSession.manager.getEntries());
  const applied = applyContextEdit(rawPayload, model?.api, editLayer);
  const edited = applied.payload as typeof rawPayload;
  // 与真实详情一致：把消息按区域分类（本轮输入/历史用户/助手/工具结果/注入指令…），
  // 否则界面只能显示"未分类"。用的是捕获记录同一解析器。
  // 预览是 Pi 形态（role=`toolResult`），分类器按 Provider 角色识别（`tool`）——
  // 解析前做一次角色归一（只影响分类，不改展示形态）。
  const normalizedForRegions = {
    ...edited,
    messages: (edited.messages as Record<string, unknown>[]).map((message) =>
      message.role === "toolResult" ? { ...message, role: "tool" } : message),
  };
  const parsed = parseProviderPayloadRegions(normalizedForRegions, model?.api, undefined);
  const messageRegions = parsed.messages?.map((message) => ({
    index: message.index,
    role: message.role,
    region: message.region,
    ...(message.customType === undefined ? {} : { customType: message.customType }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
  }));
  return {
    payload: edited,
    excludedCount: applied.excludedCount,
    ...(messageRegions === undefined ? {} : { messageRegions }),
    systemPrompt: session.systemPrompt,
    tools,
    messages,
    model: { provider: model?.provider ?? "", modelId: model?.id ?? "" },
  };
}

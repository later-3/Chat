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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openChatSession } from "../chat-session.js";
import { resolveChatHome } from "../chat-home.js";
import { createChatPiAgentSession } from "../agents/pi-agent-session.js";
import { prepareChatWorkflowTurnConfiguration } from "../workflows/workflow-configuration.js";
import { prepareLongAgentAssembly } from "./assembly.js";
import { readLongAgentAgentGroup } from "./agent-group-service.js";
import { readLongAgentRegistry } from "./storage.js";
import { longAgentWorkflowConfiguration } from "./workflow-configuration.js";

export interface SendPreviewTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface SendPreview {
  readonly systemPrompt: string;
  readonly tools: readonly SendPreviewTool[];
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
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
    ...contextMessages.map((message) => ({ role: String(message.role), content: (message as { content?: unknown }).content ?? "" })),
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
  return {
    systemPrompt: session.systemPrompt,
    tools,
    messages,
    model: { provider: model?.provider ?? "", modelId: model?.id ?? "" },
  };
}

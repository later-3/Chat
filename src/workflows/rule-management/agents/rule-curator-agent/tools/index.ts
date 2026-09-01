import { Type } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getStoredAgentConfigs, resolveChatConfig } from "../../../../../chat-config.js";
import {
  addressPromptResourceDraft,
  addressPromptResourceRevision,
  getPromptResourceStore,
  listPromptResourceDrafts,
  listPromptResources,
} from "../../../../../prompt-resources/store.js";
import {
  promptResourceTargetKey,
  type PromptResourceAuthor,
  type PromptResourceKind,
  type PromptResourceTarget,
} from "../../../../../prompt-resources/types.js";
import { getChatWorkflowDefinition } from "../../../../registry.js";
import {
  appendChatPromptResourceProposal,
  collectChatPromptResourceProposals,
  resolveChatPromptResourceProposal,
} from "../../../../prompt-resource-proposal.js";
import {
  collectChatWorkflowMessages,
  collectChatWorkflowStageMarkers,
  type ChatWorkflowMessageMarker,
  type ChatWorkflowStageMarker,
} from "../../../../workflow-stage.js";
import {
  collectLatestChatWorkflowConfigurations,
  setChatWorkflowAgentPromptResources,
} from "../../../../workflow-configuration.js";

export interface RuleManagementToolContext {
  readonly chatHome: string;
  readonly projectId: string;
  readonly sessionManager: SessionManager;
  readonly invocationId: string;
  readonly userPrompt: string;
  readonly workflowId: string;
  readonly agentId: string;
}

const targetSchema = Type.Union([
  Type.Object({ type: Type.Literal("personal") }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("project"),
    projectId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

const resourceSelectionSchema = Type.Object({
  target: targetSchema,
  resourceId: Type.String({ minLength: 1, description: "Prompt资源ID" }),
  reason: Type.String({ minLength: 1, description: "选择该资源的具体原因" }),
}, { additionalProperties: false });

const SESSION_CONTEXT_DEFAULT_LIMIT = 24;
const SESSION_CONTEXT_MAX_TEXT_CHARS = 6_000;

interface SessionSourceEntry {
  readonly entryId: string;
  readonly timestamp: string;
  readonly role: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly currentRequest: boolean;
  readonly workflow?: {
    readonly invocationId: string;
    readonly workflowId: string;
    readonly stageId: string;
    readonly agentId: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (
    isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []
  )).join("\n");
}

function messageText(message: unknown): string {
  return isRecord(message) ? contentText(message.content) : "";
}

function entryInvocationId(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom" || !isRecord(entry.data)) return undefined;
  return typeof entry.data.invocationId === "string" ? entry.data.invocationId : undefined;
}

function truncateSourceText(text: string): { text: string; textTruncated: boolean } {
  if (text.length <= SESSION_CONTEXT_MAX_TEXT_CHARS) return { text, textTruncated: false };
  return { text: text.slice(0, SESSION_CONTEXT_MAX_TEXT_CHARS), textTruncated: true };
}

function workflowReference(stage: ChatWorkflowStageMarker | ChatWorkflowMessageMarker | undefined) {
  return stage === undefined || stage.agentId === undefined
    ? undefined
    : {
        invocationId: stage.invocationId,
        workflowId: stage.workflowId,
        stageId: stage.stageId,
        agentId: stage.agentId,
      };
}

function collectSessionSourceEntries(context: RuleManagementToolContext): SessionSourceEntry[] {
  const branch = context.sessionManager.getBranch();
  const boundaryIndex = branch.findIndex((entry) => entryInvocationId(entry) === context.invocationId);
  const currentInvocationStart = boundaryIndex === -1 ? branch.length : boundaryIndex;
  let currentUserEntryId: string | undefined;
  for (let index = currentInvocationStart; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry === undefined) continue;
    if (entry.type === "message" && entry.message.role === "user") currentUserEntryId = entry.id;
  }

  const stages = new Map(
    collectChatWorkflowStageMarkers(branch).map((stage) => [stage.entryId, stage]),
  );
  const workflowMessages = new Map(
    collectChatWorkflowMessages(branch).map((message) => [message.entryId, message]),
  );
  const sourceEntries: SessionSourceEntry[] = [];
  let activeStage: ChatWorkflowStageMarker | undefined;

  for (let index = 0; index < branch.length; index += 1) {
    const entry = branch[index];
    if (entry === undefined) continue;
    const stage = stages.get(entry.id);
    if (stage !== undefined) activeStage = stage;
    const isCurrentRequest = entry.id === currentUserEntryId;
    if (index >= currentInvocationStart && !isCurrentRequest) continue;

    const workflowMessage = workflowMessages.get(entry.id);
    const rawText = workflowMessage === undefined
      ? entry.type === "message"
        ? messageText(entry.message)
        : entry.type === "custom_message"
          ? contentText(entry.content)
          : entry.type === "compaction" || entry.type === "branch_summary"
            ? entry.summary
            : ""
      : messageText(workflowMessage.message);
    const text = isCurrentRequest ? context.userPrompt : rawText;
    if (text.trim() === "") continue;
    const excerpt = truncateSourceText(text);
    const workflow = workflowMessage === undefined
      ? workflowReference(activeStage)
      : workflowReference(workflowMessage);
    const role = workflowMessage === undefined
      ? entry.type === "message"
        ? entry.message.role
        : entry.type === "compaction"
          ? "compactionSummary"
          : entry.type === "branch_summary"
            ? "branchSummary"
            : "custom"
      : "assistant";
    sourceEntries.push({
      entryId: entry.id,
      timestamp: entry.timestamp,
      role,
      ...excerpt,
      currentRequest: isCurrentRequest,
      ...(workflow === undefined ? {} : { workflow }),
    });
  }
  return sourceEntries;
}

function normalizeTarget(value: { type: "personal" } | { type: "project"; projectId: string }): PromptResourceTarget {
  return value.type === "personal" ? { type: "personal" } : { type: "project", projectId: value.projectId };
}

function currentProjectTarget(context: RuleManagementToolContext): PromptResourceTarget {
  return { type: "project", projectId: context.projectId };
}

function defaultReadTargets(context: RuleManagementToolContext): PromptResourceTarget[] {
  return [{ type: "personal" }, currentProjectTarget(context)];
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("操作已取消");
}

function requireCurrentTurnPhrase(userPrompt: string, supplied: string, expected: string): void {
  if (supplied !== expected || !userPrompt.includes(expected)) {
    throw new Error(`当前用户消息必须包含完整确认短语：${expected}`);
  }
}

function requireTarget(workflowId: string, agentId: string) {
  const workflow = getChatWorkflowDefinition(workflowId);
  const agent = workflow?.agents.find((candidate) => candidate.id === agentId);
  if (workflow === undefined || agent === undefined) throw new Error(`找不到目标Workflow或Agent: ${workflowId}/${agentId}`);
  return { workflow, agent };
}

function validateEntryIds(context: RuleManagementToolContext, entryIds: readonly string[]): void {
  if (entryIds.length === 0) throw new Error("Rule Agent创建Session来源草稿时必须选择至少一个相关Entry");
  const available = new Set(collectSessionSourceEntries(context).map((entry) => entry.entryId));
  const invalid = entryIds.filter((entryId) => !available.has(entryId));
  if (invalid.length > 0) {
    throw new Error(`来源Entry不属于当前Session活动分支的可引用上下文: ${invalid.join(", ")}`);
  }
}

function selectionKey(selection: { readonly target: PromptResourceTarget; readonly id: string }): string {
  return `${promptResourceTargetKey(selection.target)}:${selection.id}`;
}

const author = (agentId: string): PromptResourceAuthor => ({ type: "agent", agentId });

export function createRuleManagementTools(context: RuleManagementToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "session_context_read",
      label: "读取Session上下文",
      description: "分页读取当前Session活动分支中的可引用对话及其Pi Entry ID，自动排除本次规则管理操作产生的Assistant与Tool记录。",
      parameters: Type.Object({
        beforeEntryId: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        const entries = collectSessionSourceEntries(context);
        const end = params.beforeEntryId === undefined
          ? entries.length
          : entries.findIndex((entry) => entry.entryId === params.beforeEntryId);
        if (end === -1) throw new Error(`找不到可引用的Session Entry: ${params.beforeEntryId}`);
        const limit = params.limit ?? SESSION_CONTEXT_DEFAULT_LIMIT;
        const start = Math.max(0, end - limit);
        const page = entries.slice(start, end);
        return textResult({
          sessionId: context.sessionManager.getSessionId(),
          entries: page,
          hasMore: start > 0,
          ...(start > 0 && page[0] !== undefined ? { nextBeforeEntryId: page[0].entryId } : {}),
        });
      },
    }),
    defineTool({
      name: "prompt_resource_search",
      label: "搜索规则与经验",
      description: "搜索Personal、当前Project或显式指定Project中的已确认Prompt资源。",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        kind: Type.Optional(Type.Union([Type.Literal("rule"), Type.Literal("experience")])),
        tags: Type.Optional(Type.Array(Type.String())),
        targets: Type.Optional(Type.Array(targetSchema, { minItems: 1, maxItems: 20 })),
        includeArchived: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        const targets = params.targets?.map(normalizeTarget) ?? defaultReadTargets(context);
        return textResult({
          resources: await listPromptResources(targets, {
            ...(params.query === undefined ? {} : { query: params.query }),
            ...(params.kind === undefined ? {} : { kind: params.kind as PromptResourceKind }),
            ...(params.tags === undefined ? {} : { tags: params.tags }),
            status: params.includeArchived === true ? "all" : "active",
          }, context.chatHome),
        });
      },
    }),
    defineTool({
      name: "prompt_resource_get",
      label: "读取规则或经验",
      description: "按精确Target和资源ID读取当前内容、来源和版本。",
      parameters: Type.Object({ target: targetSchema, resourceId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        const target = normalizeTarget(params.target);
        const resource = await (await getPromptResourceStore(target, context.chatHome)).get(params.resourceId);
        if (resource === undefined) throw new Error(`找不到Prompt资源: ${params.resourceId}`);
        return textResult({ resource: addressPromptResourceRevision(target, resource) });
      },
    }),
    defineTool({
      name: "prompt_resource_list_drafts",
      label: "查看规则草稿",
      description: "列出尚未确认的草稿。默认读取Personal和当前Project。",
      parameters: Type.Object({
        targets: Type.Optional(Type.Array(targetSchema, { minItems: 1, maxItems: 20 })),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        return textResult({
          drafts: await listPromptResourceDrafts(
            params.targets?.map(normalizeTarget) ?? defaultReadTargets(context),
            context.chatHome,
          ),
        });
      },
    }),
    defineTool({
      name: "prompt_resource_create_draft",
      label: "创建规则草稿",
      description: "在指定Target创建规则或经验草稿。省略Target时写入当前Project；不会直接提交。",
      parameters: Type.Object({
        target: Type.Optional(targetSchema),
        baseResourceId: Type.Optional(Type.String()),
        kind: Type.Union([Type.Literal("rule"), Type.Literal("experience")]),
        title: Type.String(),
        purpose: Type.String(),
        content: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
        context: Type.String({ description: "概括形成这条规则的当前对话背景" }),
        entryIds: Type.Array(Type.String(), { minItems: 1, maxItems: 128 }),
        status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("archived")])),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        validateEntryIds(context, params.entryIds);
        const target = params.target === undefined ? currentProjectTarget(context) : normalizeTarget(params.target);
        const draft = await (await getPromptResourceStore(target, context.chatHome)).createDraft({
          ...(params.baseResourceId === undefined ? {} : { baseResourceId: params.baseResourceId }),
          kind: params.kind as PromptResourceKind,
          title: params.title,
          purpose: params.purpose,
          content: params.content,
          ...(params.tags === undefined ? {} : { tags: params.tags }),
          ...(params.status === undefined ? {} : { status: params.status }),
          sources: [{
            type: "session",
            projectId: context.projectId,
            sessionId: context.sessionManager.getSessionId(),
            workflowInvocationId: context.invocationId,
            entryIds: params.entryIds,
            context: params.context,
            capturedAt: new Date().toISOString(),
          }],
          author: author(context.agentId),
        });
        return textResult({
          draft: addressPromptResourceDraft(target, draft),
          status: "draft",
          confirmationPhrase: `确认提交草稿 ${draft.id}`,
        });
      },
    }),
    defineTool({
      name: "prompt_resource_update_draft",
      label: "修改规则草稿",
      description: "按Target、草稿ID和updatedAt乐观锁修改草稿。",
      parameters: Type.Object({
        target: targetSchema,
        draftId: Type.String(),
        expectedUpdatedAt: Type.String(),
        title: Type.Optional(Type.String()),
        purpose: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("archived")])),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        const target = normalizeTarget(params.target);
        const { draftId, expectedUpdatedAt, target: _target, ...changes } = params;
        const draft = await (await getPromptResourceStore(target, context.chatHome)).updateDraft(draftId, {
          expectedUpdatedAt,
          ...changes,
        });
        return textResult({
          draft: addressPromptResourceDraft(target, draft),
          confirmationPhrase: `确认提交草稿 ${draft.id}`,
        });
      },
    }),
    defineTool({
      name: "prompt_resource_commit_draft",
      label: "提交规则草稿",
      description: "仅当当前用户消息包含绑定该draftId的完整确认短语时提交。",
      parameters: Type.Object({
        target: targetSchema,
        draftId: Type.String(),
        userConfirmation: Type.String(),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        requireCurrentTurnPhrase(context.userPrompt, params.userConfirmation, `确认提交草稿 ${params.draftId}`);
        const target = normalizeTarget(params.target);
        const resource = await (await getPromptResourceStore(target, context.chatHome)).commitDraft(params.draftId);
        return textResult({ resource: addressPromptResourceRevision(target, resource) });
      },
    }),
    defineTool({
      name: "prompt_resource_propose_for_agent",
      label: "建议Agent规则",
      description: "为指定Workflow Agent提出Prompt资源建议；确认前不修改配置。",
      parameters: Type.Object({
        targetWorkflowId: Type.String(),
        targetAgentId: Type.String(),
        resources: Type.Array(resourceSelectionSchema, { minItems: 1, maxItems: 64 }),
        summary: Type.String(),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        requireTarget(params.targetWorkflowId, params.targetAgentId);
        for (const selected of params.resources) {
          const target = normalizeTarget(selected.target);
          const resource = await (await getPromptResourceStore(target, context.chatHome)).get(selected.resourceId);
          if (resource === undefined || resource.status !== "active") {
            throw new Error(`找不到可用Prompt资源: ${promptResourceTargetKey(target)}/${selected.resourceId}`);
          }
        }
        const proposalId = appendChatPromptResourceProposal(context.sessionManager, {
          invocationId: context.invocationId,
          sourceWorkflowId: context.workflowId,
          sourceAgentId: context.agentId,
          targetWorkflowId: params.targetWorkflowId,
          targetAgentId: params.targetAgentId,
          promptResources: params.resources.map((resource) => ({
            id: resource.resourceId,
            target: normalizeTarget(resource.target),
            selectedBy: "agent" as const,
            reason: resource.reason,
          })),
          summary: params.summary,
        });
        return textResult({
          proposalId,
          status: "pending",
          confirmationPhrase: `确认应用建议 ${proposalId}`,
          rejectionPhrase: `拒绝建议 ${proposalId}`,
        });
      },
    }),
    defineTool({
      name: "prompt_resource_apply_proposal",
      label: "应用Agent规则建议",
      description: "确认后保留用户手选资源，并替换目标Agent以前由Agent自动选择的资源。",
      parameters: Type.Object({
        proposalId: Type.String(),
        userConfirmation: Type.String(),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        requireCurrentTurnPhrase(context.userPrompt, params.userConfirmation, `确认应用建议 ${params.proposalId}`);
        const proposal = collectChatPromptResourceProposals(context.sessionManager.getEntries())
          .find((candidate) => candidate.id === params.proposalId);
        if (proposal === undefined) throw new Error(`找不到规则建议: ${params.proposalId}`);
        if (proposal.resolution !== undefined) throw new Error(`规则建议已经${proposal.resolution.status}`);
        requireTarget(proposal.targetWorkflowId, proposal.targetAgentId);
        const current = collectLatestChatWorkflowConfigurations(context.sessionManager.getEntries());
        const manual = current[proposal.targetWorkflowId]?.[proposal.targetAgentId]?.promptResources
          ?.filter((resource) => resource.selectedBy === "user") ?? [];
        const manualKeys = new Set(manual.map(selectionKey));
        const agentSelected = [];
        for (const selected of proposal.promptResources) {
          const resource = await (await getPromptResourceStore(selected.target, context.chatHome)).get(selected.id);
          if (resource === undefined || resource.status !== "active") {
            throw new Error(`找不到可用Prompt资源: ${promptResourceTargetKey(selected.target)}/${selected.id}`);
          }
          if (!manualKeys.has(selectionKey(selected))) agentSelected.push(selected);
        }
        const config = (await resolveChatConfig(context.projectId, context.chatHome)).effective;
        const defaults = getStoredAgentConfigs(config, proposal.targetWorkflowId);
        const configuration = setChatWorkflowAgentPromptResources(context.sessionManager, {
          workflowId: proposal.targetWorkflowId,
          agentId: proposal.targetAgentId,
          promptResources: [...manual, ...agentSelected],
          ...(defaults === undefined ? {} : { defaults }),
          actorAgentId: context.agentId,
        });
        resolveChatPromptResourceProposal(context.sessionManager, params.proposalId, "applied");
        return textResult({
          proposalId: params.proposalId,
          status: "applied",
          agentConfig: configuration[proposal.targetAgentId] ?? {},
        });
      },
    }),
    defineTool({
      name: "prompt_resource_dismiss_proposal",
      label: "拒绝Agent规则建议",
      description: "仅当当前用户消息包含绑定proposalId的拒绝短语时关闭建议，不修改配置。",
      parameters: Type.Object({
        proposalId: Type.String(),
        userRejection: Type.String(),
      }, { additionalProperties: false }),
      async execute(_callId, params, signal) {
        assertNotAborted(signal);
        requireCurrentTurnPhrase(context.userPrompt, params.userRejection, `拒绝建议 ${params.proposalId}`);
        const proposal = collectChatPromptResourceProposals(context.sessionManager.getEntries())
          .find((candidate) => candidate.id === params.proposalId);
        if (proposal === undefined) throw new Error(`找不到规则建议: ${params.proposalId}`);
        if (proposal.resolution !== undefined) throw new Error(`规则建议已经${proposal.resolution.status}`);
        resolveChatPromptResourceProposal(context.sessionManager, params.proposalId, "dismissed");
        return textResult({ proposalId: params.proposalId, status: "dismissed" });
      },
    }),
  ];
}

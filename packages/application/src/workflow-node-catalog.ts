import { z } from "zod";
import {
  WORKFLOW_NODE_TYPES,
  type WorkflowExecutorKind,
  type WorkflowNodeTypeKey,
  type WorkflowRiskLevel,
  type WorkflowSkipPolicy,
  type WorkflowSlotDescriptor,
} from "@chat/domain";
import {
  agentRuntimeResourcePolicySchema,
  agentTemporaryConfigurationSchema,
  agentVersionIdSchema,
  directAgentToolNameSchema,
  inspectDirectAgentConfigurationSource,
  sha256Schema,
  workflowMemoryQueryNodeConfigSchema,
  workflowMemoryWriteNodeConfigSchema,
} from "@chat/contracts";

export type PublicConfigField =
  | {
      readonly type: "boolean";
      readonly name: string;
      readonly label: string;
      readonly defaultValue: boolean;
    }
  | {
      readonly type: "enum_select" | "review_mode";
      readonly name: string;
      readonly label: string;
      readonly defaultValue: string;
      readonly options: readonly string[];
    }
  | {
      readonly type: "bounded_integer";
      readonly name: string;
      readonly label: string;
      readonly defaultValue: number;
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly type: "short_text";
      readonly name: string;
      readonly label: string;
      readonly defaultValue: string;
      readonly maximumLength: number;
    }
  | {
      readonly type: "long_text";
      readonly name: string;
      readonly label: string;
      readonly defaultValue: string;
      readonly maximumLength: number;
    }
  | {
      readonly type: "tag_list";
      readonly name: string;
      readonly label: string;
      readonly maxItems: number;
      readonly maxLabelLength: number;
    }
  | {
      readonly type:
        | "resource_selector"
        | "memory_provider_selector"
        | "rule_selector"
        | "skill_selector"
        | "note_source_selector";
      readonly name: string;
      readonly label: string;
      readonly multiple: boolean;
      readonly required: boolean;
    };

export interface NodeCatalogDescriptor {
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly displayName: string;
  readonly description: string;
  readonly category:
    "context" | "policy" | "agent" | "human" | "execution" | "validation" | "commit" | "note";
  /** 服务端解析器才是配置权威；publicConfigFields只是可安全公开的表单投影。 */
  readonly configSchema: z.ZodType<Record<string, unknown>>;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly publicConfigFields: readonly PublicConfigField[];
  readonly inputSlots: readonly WorkflowSlotDescriptor[];
  readonly outputSlots: readonly WorkflowSlotDescriptor[];
  readonly outcomes: readonly string[];
  readonly skipPolicy: WorkflowSkipPolicy;
  readonly riskPolicy: WorkflowRiskLevel;
  readonly executorKind: WorkflowExecutorKind;
  readonly supportedBlueprints: readonly ("planning" | "note" | "direct")[];
}

export function nodeExecutorKey(nodeType: WorkflowNodeTypeKey, schemaVersion: number): string {
  return `${nodeType}@${String(schemaVersion)}`;
}

/**
 * Catalog在Application组合，不向浏览器暴露Zod，也不给Executor开放动态注册入口。
 * 构造时失败表示部署包自身不一致，因此应在启动/测试阶段失败关闭。
 */
export class NodeCatalog {
  readonly #byKey: ReadonlyMap<string, NodeCatalogDescriptor>;

  constructor(descriptors: readonly NodeCatalogDescriptor[]) {
    const byKey = new Map<string, NodeCatalogDescriptor>();
    for (const descriptor of descriptors) {
      const key = nodeExecutorKey(descriptor.nodeType, descriptor.schemaVersion);
      if (byKey.has(key)) throw new Error(`workflow.catalog.duplicate_key:${key}`);
      assertDescriptorConformance(descriptor);
      byKey.set(key, descriptor);
    }
    this.#byKey = byKey;
  }

  list(): readonly NodeCatalogDescriptor[] {
    return [...this.#byKey.values()].sort((left, right) =>
      nodeExecutorKey(left.nodeType, left.schemaVersion).localeCompare(
        nodeExecutorKey(right.nodeType, right.schemaVersion),
      ),
    );
  }

  get(nodeType: WorkflowNodeTypeKey, schemaVersion: number): NodeCatalogDescriptor | undefined {
    return this.#byKey.get(nodeExecutorKey(nodeType, schemaVersion));
  }

  parseConfig(
    nodeType: WorkflowNodeTypeKey,
    schemaVersion: number,
    input: unknown,
  ):
    | { readonly success: true; readonly data: Readonly<Record<string, unknown>> }
    | {
        readonly success: false;
        readonly issues: readonly { readonly path: string; readonly code: string }[];
      } {
    const descriptor = this.get(nodeType, schemaVersion);
    if (descriptor === undefined) {
      return { success: false, issues: [{ path: "$", code: "catalog.node_type_not_registered" }] };
    }
    const parsed = descriptor.configSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
          code: `config.${issue.code}`,
        })),
      };
    }
    return { success: true, data: parsed.data };
  }
}

const booleanField = (name: string, label: string, defaultValue: boolean): PublicConfigField => ({
  type: "boolean",
  name,
  label,
  defaultValue,
});

const integerField = (
  name: string,
  label: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): PublicConfigField => ({
  type: "bounded_integer",
  name,
  label,
  defaultValue,
  minimum,
  maximum,
});

const reviewModeField = (
  defaultValue: "manual",
  options: readonly ("manual" | "auto_continue_if_policy_allows")[],
): PublicConfigField => ({
  type: "review_mode",
  name: "reviewMode",
  label: "审核方式",
  defaultValue,
  options,
});

const noteKindField = (): PublicConfigField => ({
  type: "enum_select",
  name: "defaultKind",
  label: "默认笔记类型",
  defaultValue: "general",
  options: ["idea", "project_idea", "learning", "general"],
});

const directCapabilityModeField = (): PublicConfigField => ({
  type: "enum_select",
  name: "capabilityMode",
  label: "能力模式",
  defaultValue: "pi_cli_default",
  options: ["pi_cli_default", "read_only", "project_bootstrap"],
});

const directPromptReviewModeField = (): PublicConfigField => ({
  type: "enum_select",
  name: "promptReviewMode",
  label: "发送前审核提示词",
  defaultValue: "manual",
  options: ["manual", "off"],
});

const agentKeyField = (defaultValue: string, options: readonly string[]): PublicConfigField => ({
  type: "enum_select",
  name: "agentKey",
  label: "Agent 模板",
  defaultValue,
  options,
});

const agentPromptOverrideField = (): PublicConfigField => ({
  type: "long_text",
  name: "agentPromptOverride",
  label: "节点 System Prompt",
  defaultValue: "",
  maximumLength: 65_536,
});

const slot = (
  name: string,
  valueKind: WorkflowSlotDescriptor["valueKind"],
  required: boolean,
  multiple = false,
): WorkflowSlotDescriptor => ({ name, valueKind, required, multiple });

const EMPTY_CONFIG = z.strictObject({});
const REQUIRED_CONTEXT_CONFIG = z.strictObject({ required: z.boolean().default(false) });
const REVIEW_CONFIG = z.strictObject({
  reviewMode: z.enum(["manual", "auto_continue_if_policy_allows", "always_auto"]).default("manual"),
});

export const NODE_CATALOG_DESCRIPTORS: readonly NodeCatalogDescriptor[] = [
  {
    nodeType: "memory.query",
    schemaVersion: 1,
    displayName: "查询记忆",
    description: "从服务端配置的Memory Provider查询，并冻结可供后续节点消费的快照",
    category: "context",
    configSchema: workflowMemoryQueryNodeConfigSchema,
    defaultConfig: {
      providerId: "mbk_tencentmemorycore",
      required: false,
      querySource: "source_message",
      maxResults: 8,
      maxContextCharacters: 8_000,
    },
    publicConfigFields: [
      {
        type: "memory_provider_selector",
        name: "providerId",
        label: "Memory服务",
        multiple: false,
        required: true,
      },
      booleanField("required", "查询失败时停止工作流", false),
      integerField("maxResults", "最多采用条数", 8, 1, 20),
      integerField("maxContextCharacters", "最多上下文字符", 8_000, 128, 50_000),
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("snapshots", "memory_snapshot_ref", false, true)],
    outcomes: ["success", "empty", "optional_unavailable", "required_unavailable"],
    skipPolicy: { kind: "allowed_with_default_outcome", defaultOutcome: "optional_unavailable" },
    riskPolicy: "read_context",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "memory.write",
    schemaVersion: 1,
    displayName: "写入记忆",
    description: "把经过明确选择的Chat内容写入Memory Provider，并保留对账终态",
    category: "commit",
    configSchema: workflowMemoryWriteNodeConfigSchema,
    defaultConfig: {
      providerId: "mbk_tencentmemorycore",
      source: "source_message",
      contentType: "conversation_turn",
    },
    publicConfigFields: [
      {
        type: "memory_provider_selector",
        name: "providerId",
        label: "Memory服务",
        multiple: false,
        required: true,
      },
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("write", "memory_write_ref", true)],
    outcomes: ["accepted", "materialized", "failed", "outcome_unknown"],
    skipPolicy: { kind: "never" },
    riskPolicy: "external_effect",
    executorKind: "step",
    // 只允许显式发布的独立Memory Planning Definition使用；普通Planning种子不包含它。
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "context.memory",
    schemaVersion: 1,
    displayName: "读取记忆",
    description: "历史定义兼容节点；新定义使用memory.query",
    category: "context",
    configSchema: z.strictObject({
      required: z.boolean().default(false),
      maxItems: z.number().int().min(1).max(20).default(8),
    }),
    defaultConfig: { required: false, maxItems: 8 },
    publicConfigFields: [
      booleanField("required", "必须获得记忆", false),
      integerField("maxItems", "最多记忆条数", 8, 1, 20),
      {
        type: "resource_selector",
        name: "selection",
        label: "记忆来源",
        multiple: true,
        required: false,
      },
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("contextPackage", "context_package_ref", false)],
    outcomes: ["success", "optional_unavailable", "required_unavailable"],
    skipPolicy: { kind: "allowed_with_default_outcome", defaultOutcome: "optional_unavailable" },
    riskPolicy: "read_context",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "context.project",
    schemaVersion: 1,
    displayName: "读取项目上下文",
    description: "按精确Project Context revision/hash加载上下文",
    category: "context",
    configSchema: REQUIRED_CONTEXT_CONFIG,
    defaultConfig: { required: false },
    publicConfigFields: [
      booleanField("required", "必须获得项目上下文", false),
      {
        type: "resource_selector",
        name: "selection",
        label: "项目",
        multiple: false,
        required: false,
      },
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("projectContext", "project_context_ref", false)],
    outcomes: ["success", "optional_unavailable", "required_unavailable"],
    skipPolicy: { kind: "allowed_with_default_outcome", defaultOutcome: "optional_unavailable" },
    riskPolicy: "read_context",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "policy.rules",
    schemaVersion: 1,
    displayName: "解析规则",
    description: "解析用户明确选择或允许召回的规则revision",
    category: "policy",
    configSchema: REQUIRED_CONTEXT_CONFIG,
    defaultConfig: { required: false },
    publicConfigFields: [
      booleanField("required", "规则必须可用", false),
      { type: "rule_selector", name: "selection", label: "规则", multiple: true, required: false },
    ],
    inputSlots: [],
    outputSlots: [slot("rules", "rule_resolution_ref", false)],
    outcomes: ["resolved", "optional_unavailable", "required_unavailable"],
    skipPolicy: { kind: "allowed_with_default_outcome", defaultOutcome: "optional_unavailable" },
    riskPolicy: "read_context",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "capability.skills",
    schemaVersion: 1,
    displayName: "解析技能",
    description: "从已批准Capability目录冻结本次Skill选择",
    category: "policy",
    configSchema: REQUIRED_CONTEXT_CONFIG,
    defaultConfig: { required: false },
    publicConfigFields: [
      booleanField("required", "技能必须可用", false),
      { type: "skill_selector", name: "selection", label: "技能", multiple: true, required: false },
    ],
    inputSlots: [],
    outputSlots: [slot("skills", "skill_resolution_ref", false)],
    outcomes: ["resolved", "optional_unavailable", "required_unavailable"],
    skipPolicy: { kind: "allowed_with_default_outcome", defaultOutcome: "optional_unavailable" },
    riskPolicy: "read_context",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "agent.research",
    schemaVersion: 1,
    displayName: "调研",
    description: "旧定义兼容节点；当前没有受治理调研底座时固定跳过并返回no_evidence",
    category: "agent",
    configSchema: EMPTY_CONFIG,
    defaultConfig: {},
    publicConfigFields: [],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("evidence", "evidence_ref", false, true)],
    outcomes: ["researched", "no_evidence"],
    skipPolicy: { kind: "allowed_with_default_outcome", defaultOutcome: "no_evidence" },
    riskPolicy: "generate_candidate",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "agent.plan",
    schemaVersion: 1,
    displayName: "生成计划",
    description: "根据冻结上下文产生可审核Plan Revision",
    category: "agent",
    configSchema: z.strictObject({
      maxSteps: z.number().int().min(1).max(20).default(8),
      agentKey: z.literal("planner").optional(),
      agentPromptOverride: z.string().max(65_536).optional(),
    }),
    defaultConfig: { maxSteps: 8 },
    publicConfigFields: [
      agentKeyField("planner", ["planner"]),
      agentPromptOverrideField(),
      integerField("maxSteps", "最多计划步骤", 8, 1, 20),
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("plan", "plan_revision_ref", true)],
    outcomes: ["planned", "needs_input"],
    skipPolicy: { kind: "never" },
    riskPolicy: "generate_candidate",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "agent.direct",
    schemaVersion: 1,
    displayName: "执行 Agent",
    description: "推进同一个Pi AgentSession；可在每次Provider发送前进入节点内部人工审核",
    category: "agent",
    configSchema: z
      .strictObject({
        capabilityMode: z
          .enum(["pi_cli_default", "custom", "read_only", "project_bootstrap"])
          .default("pi_cli_default"),
        promptReviewMode: z.enum(["manual", "off"]).default("manual"),
        agentKey: z.enum(["direct", "project_bootstrap"]).optional(),
        agentVersionId: agentVersionIdSchema.optional(),
        agentVersionSha256: sha256Schema.optional(),
        agentPromptOverride: z.string().max(65_536).optional(),
        enabledToolNames: z.array(directAgentToolNameSchema).max(32).optional(),
        resourcePolicy: agentRuntimeResourcePolicySchema.optional(),
        agentTemporaryConfiguration: agentTemporaryConfigurationSchema.optional(),
      })
      .superRefine((value, ctx) => {
        const source = inspectDirectAgentConfigurationSource(value);
        if (!source.valid)
          ctx.addIssue({
            code: "custom",
            path:
              source.reason === "agent.configuration.version_reference_incomplete"
                ? ["agentVersionId"]
                : ["agentTemporaryConfiguration"],
            message:
              source.reason === "agent.configuration.version_reference_incomplete"
                ? "Agent Version必须同时绑定合法ID与Hash"
                : "Agent Version、临时Agent配置与Prompt Override只能选择一种来源",
          });
        if (
          value.capabilityMode === "custom" &&
          value.agentVersionId === undefined &&
          value.enabledToolNames === undefined
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["enabledToolNames"],
            message: "Custom Agent能力必须由Agent Version或显式Tool清单冻结",
          });
        }
      }),
    defaultConfig: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
    publicConfigFields: [
      agentKeyField("direct", ["direct", "project_bootstrap"]),
      agentPromptOverrideField(),
      directCapabilityModeField(),
      directPromptReviewModeField(),
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [
      slot("promptReview", "prompt_review_ref", false),
      slot("candidate", "direct_agent_candidate_ref", false),
    ],
    outcomes: ["completed"],
    skipPolicy: { kind: "never" },
    riskPolicy: "generate_candidate",
    executorKind: "composite",
    supportedBlueprints: ["direct"],
  },
  {
    nodeType: "human.plan_review",
    schemaVersion: 1,
    displayName: "审核计划",
    description: "等待已提交Plan Decision，不信任Hook正文",
    category: "human",
    configSchema: REVIEW_CONFIG,
    defaultConfig: { reviewMode: "manual" },
    publicConfigFields: [reviewModeField("manual", ["manual"])],
    inputSlots: [slot("plan", "plan_revision_ref", true)],
    outputSlots: [slot("decision", "decision_ref", true)],
    outcomes: ["approved", "request_revision", "rejected"],
    skipPolicy: { kind: "never" },
    riskPolicy: "human_decision",
    executorKind: "human_review",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "human.prompt_review",
    schemaVersion: 1,
    displayName: "审核提示词",
    description: "审核Provider发送前冻结的原始Payload及固定Renderer生成的可读投影",
    category: "human",
    configSchema: REVIEW_CONFIG,
    defaultConfig: { reviewMode: "manual" },
    publicConfigFields: [reviewModeField("manual", ["manual"])],
    inputSlots: [slot("promptReview", "prompt_review_ref", true)],
    outputSlots: [slot("decision", "decision_ref", true)],
    outcomes: ["approved", "rejected"],
    skipPolicy: { kind: "never" },
    riskPolicy: "human_decision",
    executorKind: "human_review",
    supportedBlueprints: [],
  },
  {
    nodeType: "execute.plan",
    schemaVersion: 1,
    displayName: "执行计划",
    description: "按批准的Execution Contract有界展开Action",
    category: "execution",
    configSchema: z.strictObject({
      maxActions: z.number().int().min(1).max(32).default(16),
      agentKey: z.literal("coding_executor").optional(),
      agentPromptOverride: z.string().max(65_536).optional(),
    }),
    defaultConfig: { maxActions: 16 },
    publicConfigFields: [
      agentKeyField("coding_executor", ["coding_executor"]),
      agentPromptOverrideField(),
      integerField("maxActions", "最多执行动作", 16, 1, 32),
    ],
    inputSlots: [slot("decision", "decision_ref", true)],
    outputSlots: [slot("candidate", "execution_candidate_ref", true)],
    outcomes: ["success", "failed", "outcome_unknown"],
    skipPolicy: { kind: "never" },
    riskPolicy: "external_effect",
    executorKind: "composite",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "result.validate",
    schemaVersion: 1,
    displayName: "验证结果",
    description: "确定性校验执行候选和证据",
    category: "validation",
    configSchema: z.strictObject({ strictEvidence: z.boolean().default(true) }),
    defaultConfig: { strictEvidence: true },
    publicConfigFields: [booleanField("strictEvidence", "严格证据校验", true)],
    inputSlots: [slot("candidate", "execution_candidate_ref", true)],
    outputSlots: [slot("validation", "validation_result_ref", true)],
    outcomes: ["valid", "invalid"],
    skipPolicy: { kind: "never" },
    riskPolicy: "generate_candidate",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "product.commit",
    schemaVersion: 1,
    displayName: "提交结果",
    description: "把已验证候选提交成Chat正式Artifact",
    category: "commit",
    configSchema: z.strictObject({
      format: z.enum(["markdown_sections"]).default("markdown_sections"),
    }),
    defaultConfig: { format: "markdown_sections" },
    publicConfigFields: [],
    inputSlots: [slot("validation", "validation_result_ref", true)],
    outputSlots: [slot("artifact", "artifact_ref", true)],
    outcomes: ["committed", "failed"],
    skipPolicy: { kind: "never" },
    riskPolicy: "product_commit",
    executorKind: "step",
    supportedBlueprints: ["planning"],
  },
  {
    nodeType: "note.extract",
    schemaVersion: 1,
    displayName: "提取笔记",
    description: "从消息或选择内容生成Note Candidate",
    category: "note",
    configSchema: z.strictObject({
      maxCharacters: z.number().int().min(128).max(20_000).default(4_000),
      defaultKind: z.enum(["idea", "project_idea", "learning", "general"]).default("general"),
      suggestedTagLabels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
      agentKey: z.literal("note_extractor").optional(),
      agentPromptOverride: z.string().max(65_536).optional(),
    }),
    defaultConfig: { maxCharacters: 4_000, defaultKind: "general", suggestedTagLabels: [] },
    publicConfigFields: [
      agentKeyField("note_extractor", ["note_extractor"]),
      agentPromptOverrideField(),
      {
        type: "note_source_selector",
        name: "source",
        label: "笔记来源",
        multiple: false,
        required: true,
      },
      noteKindField(),
      {
        type: "tag_list",
        name: "suggestedTagLabels",
        label: "建议标签",
        maxItems: 20,
        maxLabelLength: 64,
      },
      integerField("maxCharacters", "最多字符", 4_000, 128, 20_000),
    ],
    inputSlots: [slot("message", "message_ref", true)],
    outputSlots: [slot("candidate", "note_candidate_ref", true)],
    outcomes: ["extracted", "no_note"],
    skipPolicy: { kind: "never" },
    riskPolicy: "generate_candidate",
    executorKind: "step",
    supportedBlueprints: ["note"],
  },
  {
    nodeType: "note.classify",
    schemaVersion: 1,
    displayName: "分类笔记",
    description: "为Note Candidate产生受控标签建议",
    category: "note",
    configSchema: z.strictObject({ allowCustomTags: z.boolean().default(true) }),
    defaultConfig: { allowCustomTags: true },
    publicConfigFields: [booleanField("allowCustomTags", "允许自定义标签", true)],
    inputSlots: [slot("candidate", "note_candidate_ref", true)],
    outputSlots: [slot("candidate", "note_candidate_ref", true)],
    outcomes: ["classified", "needs_review"],
    skipPolicy: { kind: "never" },
    riskPolicy: "generate_candidate",
    executorKind: "step",
    supportedBlueprints: ["note"],
  },
  {
    nodeType: "human.note_review",
    schemaVersion: 1,
    displayName: "审核笔记",
    description: "审核正文、标签和目标位置",
    category: "human",
    configSchema: REVIEW_CONFIG,
    defaultConfig: { reviewMode: "manual" },
    publicConfigFields: [reviewModeField("manual", ["manual", "auto_continue_if_policy_allows"])],
    inputSlots: [slot("candidate", "note_candidate_ref", true)],
    outputSlots: [slot("decision", "decision_ref", true)],
    outcomes: ["approved", "request_revision", "rejected"],
    skipPolicy: { kind: "never" },
    riskPolicy: "human_decision",
    executorKind: "human_review",
    supportedBlueprints: ["note"],
  },
  {
    nodeType: "note.commit",
    schemaVersion: 1,
    displayName: "保存笔记",
    description: "把审核后的候选提交成正式Note Revision",
    category: "commit",
    configSchema: EMPTY_CONFIG,
    defaultConfig: {},
    publicConfigFields: [],
    inputSlots: [slot("candidate", "note_candidate_ref", true)],
    outputSlots: [slot("note", "note_revision_ref", true)],
    outcomes: ["committed", "failed"],
    skipPolicy: { kind: "never" },
    riskPolicy: "product_commit",
    executorKind: "step",
    supportedBlueprints: ["note"],
  },
] satisfies readonly NodeCatalogDescriptor[];

export const DEFAULT_NODE_CATALOG = new NodeCatalog(NODE_CATALOG_DESCRIPTORS);

function assertDescriptorConformance(descriptor: NodeCatalogDescriptor): void {
  if (!WORKFLOW_NODE_TYPES.includes(descriptor.nodeType)) {
    throw new Error(`workflow.catalog.unknown_node_type:${descriptor.nodeType}`);
  }
  if (!Number.isInteger(descriptor.schemaVersion) || descriptor.schemaVersion < 1) {
    throw new Error(`workflow.catalog.invalid_schema_version:${descriptor.nodeType}`);
  }
  if (
    descriptor.outcomes.length === 0 ||
    new Set(descriptor.outcomes).size !== descriptor.outcomes.length
  ) {
    throw new Error(`workflow.catalog.invalid_outcomes:${descriptor.nodeType}`);
  }
  const parsedDefault = descriptor.configSchema.safeParse(descriptor.defaultConfig);
  if (!parsedDefault.success)
    throw new Error(`workflow.catalog.default_config_invalid:${descriptor.nodeType}`);
  const fields = new Set<string>();
  for (const field of descriptor.publicConfigFields) {
    if (fields.has(field.name))
      throw new Error(
        `workflow.catalog.duplicate_public_field:${descriptor.nodeType}:${field.name}`,
      );
    fields.add(field.name);
    if (
      /secret|token|credential|password|api[_-]?key|endpoint/i.test(field.name) ||
      (/provider/i.test(field.name) && field.type !== "memory_provider_selector")
    ) {
      throw new Error(
        `workflow.catalog.forbidden_public_field:${descriptor.nodeType}:${field.name}`,
      );
    }
    if ("defaultValue" in field) {
      const result = descriptor.configSchema.safeParse({
        ...descriptor.defaultConfig,
        [field.name]: field.defaultValue,
      });
      if (!result.success)
        throw new Error(
          `workflow.catalog.public_default_invalid:${descriptor.nodeType}:${field.name}`,
        );
    }
  }
  if (
    descriptor.skipPolicy.kind === "allowed_with_default_outcome" &&
    !descriptor.outcomes.includes(descriptor.skipPolicy.defaultOutcome)
  ) {
    throw new Error(`workflow.catalog.skip_outcome_missing:${descriptor.nodeType}`);
  }
  if (
    descriptor.skipPolicy.kind === "allowed_with_explicit_value" &&
    descriptor.skipPolicy.allowedOutcomes.some((outcome) => !descriptor.outcomes.includes(outcome))
  ) {
    throw new Error(`workflow.catalog.skip_outcome_missing:${descriptor.nodeType}`);
  }
}

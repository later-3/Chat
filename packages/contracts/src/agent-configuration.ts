import { z } from "zod";
import { agentKeySchema } from "./agent-key.js";
import { sha256Schema } from "./hash.js";
import { agentVersionIdSchema, principalIdSchema } from "./ids.js";
import { promptFragmentScopeSchema } from "./prompt-fragment.js";
import {
  agentRuntimeToolNameSchema,
  piBuiltinToolNameSchema,
} from "./agent-runtime-capabilities.js";
import { capabilitySelectionRefSchema } from "./capability.js";

export const LEGACY_AGENT_VERSION_SCHEMA_VERSION = "agent-version.v1";
export const AGENT_VERSION_SCHEMA_VERSION = "agent-version.v2";

/** Later Pi Fork当前公开的全部内置工具及其上游稳定顺序。 */
export const PI_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

/** Agent管理语义下的Pi Tool边界；底层枚举与Prompt Envelope复用同一合同。 */
export const agentPiBuiltinToolNameSchema = piBuiltinToolNameSchema;

/**
 * Agent Version冻结当前Pi Runtime目录里的有序Tool子集。内置Tool与Extension Tool
 * 共用同一名字合同；Application必须再按所选Runtime Variant的真实目录校验存在性与顺序。
 */
export const agentEnabledToolNamesSchema = z
  .array(agentRuntimeToolNameSchema)
  .max(32)
  .superRefine((names, ctx) => {
    const seen = new Set<string>();
    for (const [index, name] of names.entries()) {
      if (seen.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "Agent工具不能重复",
        });
      }
      seen.add(name);
    }
  });

/** v2把qualified Ref与本地Tool投影绑定；位置、名字与身份共同进入Version Hash。 */
export const agentVersionCapabilitySelectionRefSchema = capabilitySelectionRefSchema.safeExtend({
  localName: agentRuntimeToolNameSchema,
});

export const agentRuntimeSchema = z
  .object({
    kind: z.literal("pi_coding_agent"),
    baseVariantKey: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._-]+$/u),
  })
  .strict();

export const agentSystemPromptSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inherit_runtime") }).strict(),
  z
    .object({
      mode: z.literal("replace"),
      /** 保留逐字节正文；调用方必须用同一正文计算并提交sha256。 */
      bodyMarkdown: z.string().min(1).max(131_072),
      sha256: sha256Schema,
    })
    .strict(),
]);

export const agentResourceModeSchema = z.enum(["inherit_runtime_default", "disabled"]);

export const agentResourcesSchema = z
  .object({
    contextFiles: agentResourceModeSchema,
    skills: agentResourceModeSchema,
    promptTemplates: agentResourceModeSchema,
    extensions: agentResourceModeSchema,
  })
  .strict();

export type DirectAgentConfigurationSource =
  "runtime_default" | "agent_version" | "temporary" | "legacy_prompt_override";

export type DirectAgentConfigurationSourceInspection =
  | {
      readonly valid: true;
      readonly source: DirectAgentConfigurationSource;
      readonly presentSources: readonly Exclude<
        DirectAgentConfigurationSource,
        "runtime_default"
      >[];
    }
  | {
      readonly valid: false;
      readonly reason:
        | "agent.configuration.version_reference_incomplete"
        | "agent.configuration.source_field_invalid"
        | "agent.configuration.sources_conflict";
      readonly presentSources: readonly Exclude<
        DirectAgentConfigurationSource,
        "runtime_default"
      >[];
    };

/**
 * Pi-backed Direct Agent配置来源的唯一语义。Contracts、Application与Product Store
 * 共用此判定；调用方可以显式用一次Run的结构化配置替换Definition来源，但最终对象
 * 必须只剩Version、Temporary、旧Prompt Override或Runtime默认中的一种。
 */
export function inspectDirectAgentConfigurationSource(
  config: Readonly<Record<string, unknown>>,
): DirectAgentConfigurationSourceInspection {
  const versionIdPresent = config["agentVersionId"] !== undefined;
  const versionShaPresent = config["agentVersionSha256"] !== undefined;
  const temporaryPresent = config["agentTemporaryConfiguration"] !== undefined;
  const promptOverride = config["agentPromptOverride"];
  const promptOverridePresent = typeof promptOverride === "string" && promptOverride.trim() !== "";
  const presentSources: Exclude<DirectAgentConfigurationSource, "runtime_default">[] = [
    ...(versionIdPresent || versionShaPresent ? (["agent_version"] as const) : []),
    ...(temporaryPresent ? (["temporary"] as const) : []),
    ...(promptOverridePresent ? (["legacy_prompt_override"] as const) : []),
  ];

  if (
    versionIdPresent !== versionShaPresent ||
    (versionIdPresent &&
      (typeof config["agentVersionId"] !== "string" ||
        typeof config["agentVersionSha256"] !== "string"))
  ) {
    return {
      valid: false,
      reason: "agent.configuration.version_reference_incomplete",
      presentSources,
    };
  }
  if (
    (temporaryPresent &&
      (typeof config["agentTemporaryConfiguration"] !== "object" ||
        config["agentTemporaryConfiguration"] === null)) ||
    (promptOverride !== undefined && typeof promptOverride !== "string")
  ) {
    return {
      valid: false,
      reason: "agent.configuration.source_field_invalid",
      presentSources,
    };
  }
  if (presentSources.length > 1) {
    return {
      valid: false,
      reason: "agent.configuration.sources_conflict",
      presentSources,
    };
  }
  return {
    valid: true,
    source: presentSources[0] ?? "runtime_default",
    presentSources,
  };
}

/** Agent Version绑定创建时真实Pi目录，避免同名Variant在上游升级后静默变义。 */
export const agentRuntimeBaselineRefSchema = z
  .object({
    packageName: z.literal("@earendil-works/pi-coding-agent"),
    packageVersion: z.string().min(1).max(80),
    managedSource: z.literal("later-3/pi@codex/later-custom"),
    managedSourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
    variantKey: z.string().min(2).max(80),
    capabilityCatalogSha256: sha256Schema,
  })
  .strict();

const sharedAgentVersionHashFields = {
  agentVersionId: agentVersionIdSchema,
  agentKey: agentKeySchema,
  ownerPrincipalId: principalIdSchema,
  scope: promptFragmentScopeSchema,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(1_000),
  runtime: agentRuntimeSchema,
  baselineRef: agentRuntimeBaselineRefSchema,
  systemPrompt: agentSystemPromptSchema,
  enabledToolNames: agentEnabledToolNamesSchema,
  resources: agentResourcesSchema,
  basedOnVersionId: agentVersionIdSchema.optional(),
  createdAt: z.iso.datetime(),
} as const;

const legacyAgentVersionV1HashFields = {
  schemaVersion: z.literal(LEGACY_AGENT_VERSION_SCHEMA_VERSION),
  ...sharedAgentVersionHashFields,
  /** v1从未发布qualified选择；显式拒绝用同一literal扩权。 */
  enabledCapabilityRefs: z.undefined().optional(),
} as const;

const agentVersionV2HashFields = {
  schemaVersion: z.literal(AGENT_VERSION_SCHEMA_VERSION),
  ...sharedAgentVersionHashFields,
  /** v2的权威选择不可删除；合法零Tool Agent使用显式空数组。 */
  enabledCapabilityRefs: z.array(agentVersionCapabilitySelectionRefSchema).max(32),
} as const;

function assertVersionRelations(
  value: {
    readonly agentVersionId: string;
    readonly basedOnVersionId?: string | undefined;
    readonly runtime: { readonly baseVariantKey: string };
    readonly baselineRef: { readonly variantKey: string };
    readonly enabledToolNames: readonly string[];
    readonly enabledCapabilityRefs?:
      | readonly {
          readonly localName: string;
          readonly capabilityId: string;
          readonly descriptorSha256: string;
        }[]
      | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.basedOnVersionId === value.agentVersionId) {
    ctx.addIssue({
      code: "custom",
      path: ["basedOnVersionId"],
      message: "Agent Version不能派生自自身",
    });
  }
  if (value.runtime.baseVariantKey !== value.baselineRef.variantKey) {
    ctx.addIssue({
      code: "custom",
      path: ["baselineRef", "variantKey"],
      message: "Agent Version的Runtime Variant与冻结基线必须一致",
    });
  }
  if (value.enabledCapabilityRefs !== undefined) {
    const capabilityIds = new Set<string>();
    const qualifiedRefs = new Set<string>();
    const localNames = new Set<string>();
    if (value.enabledCapabilityRefs.length !== value.enabledToolNames.length) {
      ctx.addIssue({
        code: "custom",
        path: ["enabledCapabilityRefs"],
        message: "Agent Version的Tool名字与qualified Capability Ref必须数量一致",
      });
    }
    for (const [index, ref] of value.enabledCapabilityRefs.entries()) {
      if (ref.localName !== value.enabledToolNames[index]) {
        ctx.addIssue({
          code: "custom",
          path: ["enabledCapabilityRefs", index, "localName"],
          message: "Agent Version的Capability localName必须与有序Tool清单一致",
        });
      }
      const qualifiedRef = `${ref.capabilityId}:${ref.descriptorSha256}`;
      if (
        capabilityIds.has(ref.capabilityId) ||
        qualifiedRefs.has(qualifiedRef) ||
        localNames.has(ref.localName)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["enabledCapabilityRefs", index],
          message: "Agent Version的capabilityId、qualified Capability Ref与localName不能重复",
        });
      }
      capabilityIds.add(ref.capabilityId);
      qualifiedRefs.add(qualifiedRef);
      localNames.add(ref.localName);
    }
  }
}

/** 进入Canonical Hash的精确字段；`sha256`本身不参与计算。 */
export const legacyAgentVersionV1HashInputSchema = z
  .object(legacyAgentVersionV1HashFields)
  .strict()
  .superRefine(assertVersionRelations);

export const agentVersionV2HashInputSchema = z
  .object(agentVersionV2HashFields)
  .strict()
  .superRefine(assertVersionRelations);

export const agentVersionHashInputSchema = z.union([
  legacyAgentVersionV1HashInputSchema,
  agentVersionV2HashInputSchema,
]);

/**
 * Agent Version是不可变产品事实。现有Agent Catalog继续拥有内置Agent定义；本对象只保存
 * Principal基于某个内置Agent派生出的精确版本，不建立第二套重型Agent Definition。
 */
export const legacyAgentVersionV1Schema = z
  .object({ ...legacyAgentVersionV1HashFields, sha256: sha256Schema })
  .strict()
  .superRefine(assertVersionRelations);

export const agentVersionV2Schema = z
  .object({ ...agentVersionV2HashFields, sha256: sha256Schema })
  .strict()
  .superRefine(assertVersionRelations);

export const agentVersionSchema = z.union([legacyAgentVersionV1Schema, agentVersionV2Schema]);

export type AgentPiBuiltinToolName = z.infer<typeof agentPiBuiltinToolNameSchema>;
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
export type AgentRuntimeBaselineRef = z.infer<typeof agentRuntimeBaselineRefSchema>;
export type AgentSystemPrompt = z.infer<typeof agentSystemPromptSchema>;
export type AgentResourceMode = z.infer<typeof agentResourceModeSchema>;
export type AgentResources = z.infer<typeof agentResourcesSchema>;
export type AgentVersionHashInput = z.infer<typeof agentVersionHashInputSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;

export function agentVersionHashDomain(
  version: Pick<AgentVersion, "schemaVersion">,
): "agent-version.v1" | "agent-version.v2" {
  return version.schemaVersion;
}

/** 唯一的Version→Hash输入投影，避免各层手写遗漏字段或把`sha256`递归计入。 */
export function toAgentVersionHashInput(version: AgentVersion): AgentVersionHashInput {
  const { sha256: _sha256, ...input } = version;
  void _sha256;
  return agentVersionHashInputSchema.parse(input);
}

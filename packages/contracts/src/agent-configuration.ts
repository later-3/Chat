import { z } from "zod";
import { agentKeySchema } from "./agent-key.js";
import { sha256Schema } from "./hash.js";
import { agentVersionIdSchema, principalIdSchema } from "./ids.js";
import { promptFragmentScopeSchema } from "./prompt-fragment.js";
import {
  agentRuntimeToolNameSchema,
  piBuiltinToolNameSchema,
} from "./agent-runtime-capabilities.js";

export const AGENT_VERSION_SCHEMA_VERSION = "agent-version.v1";

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

const agentVersionHashFields = {
  schemaVersion: z.literal(AGENT_VERSION_SCHEMA_VERSION),
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

function assertVersionRelations(
  value: {
    readonly agentVersionId: string;
    readonly basedOnVersionId?: string | undefined;
    readonly runtime: { readonly baseVariantKey: string };
    readonly baselineRef: { readonly variantKey: string };
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
}

/** 进入Canonical Hash的精确字段；`sha256`本身不参与计算。 */
export const agentVersionHashInputSchema = z
  .object(agentVersionHashFields)
  .strict()
  .superRefine(assertVersionRelations);

/**
 * Agent Version是不可变产品事实。现有Agent Catalog继续拥有内置Agent定义；本对象只保存
 * Principal基于某个内置Agent派生出的精确版本，不建立第二套重型Agent Definition。
 */
export const agentVersionSchema = z
  .object({ ...agentVersionHashFields, sha256: sha256Schema })
  .strict()
  .superRefine(assertVersionRelations);

export type AgentPiBuiltinToolName = z.infer<typeof agentPiBuiltinToolNameSchema>;
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
export type AgentRuntimeBaselineRef = z.infer<typeof agentRuntimeBaselineRefSchema>;
export type AgentSystemPrompt = z.infer<typeof agentSystemPromptSchema>;
export type AgentResourceMode = z.infer<typeof agentResourceModeSchema>;
export type AgentResources = z.infer<typeof agentResourcesSchema>;
export type AgentVersionHashInput = z.infer<typeof agentVersionHashInputSchema>;
export type AgentVersion = z.infer<typeof agentVersionSchema>;

/** 唯一的Version→Hash输入投影，避免各层手写遗漏字段或把`sha256`递归计入。 */
export function toAgentVersionHashInput(version: AgentVersion): AgentVersionHashInput {
  const { sha256: _sha256, ...input } = version;
  void _sha256;
  return agentVersionHashInputSchema.parse(input);
}

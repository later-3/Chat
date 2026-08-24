import { z } from "zod";
import { sha256Schema } from "./hash.js";

export const CAPABILITY_DESCRIPTOR_SCHEMA_VERSION = "capability-descriptor.v1" as const;

/**
 * Capability ID 是 Runtime 目录中的稳定、带来源身份，不是模型可见的本地 Tool 名。
 * 同名 Tool 可以拥有不同 ID；ID 本身不包含绝对路径或凭据。
 */
export const capabilityIdSchema = z
  .string()
  .min(8)
  .max(240)
  .regex(/^[a-z][a-z0-9._:-]+$/u);

export const capabilityKindSchema = z.enum([
  "executable_tool",
  "instruction_skill",
  "prompt_resource",
  "host_action",
  "provider_operation",
  "workflow_node",
]);

export const capabilityRuntimeOwnerSchema = z.enum([
  "pi_direct",
  "pi_planning",
  "dsh",
  "chat_application",
  "provider",
]);

export const capabilitySourceKindSchema = z.enum([
  "builtin",
  "managed_extension",
  "workspace_extension",
  "provider",
]);

const portableResourcePathSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => !value.startsWith("/") && !value.includes("\\"), {
    message: "Capability来源路径必须是可移植路径",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "Capability来源路径不能包含上级跳转",
  });

/** 源码版本与运行工件分开记账；闭包只能引用受管revision或artifact hash。 */
export const capabilitySourceRefSchema = z
  .object({
    sourceKind: capabilitySourceKindSchema,
    package: z.string().min(1).max(200).optional(),
    repository: z.string().min(1).max(500).optional(),
    revision: z.string().min(1).max(160).optional(),
    artifactSha256: sha256Schema.optional(),
    resourcePath: portableResourcePathSchema.optional(),
    contentSha256: sha256Schema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.package === undefined && value.repository === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["package"],
        message: "Capability来源必须声明package或repository",
      });
    }
    if (
      value.revision === undefined &&
      value.artifactSha256 === undefined &&
      value.contentSha256 === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Capability来源必须绑定revision、artifact hash或content hash",
      });
    }
    if (
      value.sourceKind === "workspace_extension" &&
      (value.resourcePath === undefined || value.contentSha256 === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["contentSha256"],
        message: "Workspace Extension必须绑定可移植路径与正文Hash",
      });
    }
  });

export const capabilityEffectSchema = z.enum(["read", "local_write", "shell", "external_write"]);
export const capabilityScopePolicySchema = z.enum([
  "global",
  "workspace_required",
  "provider_defined",
]);
export const capabilityApprovalPolicySchema = z.enum(["run_policy", "product_decision_required"]);
export const capabilityEvidencePolicySchema = z.enum(["runtime_journal", "product_intent_result"]);
export const capabilityReadinessSchema = z.enum(["available", "unavailable", "paused"]);

const descriptorFields = {
  schemaVersion: z.literal(CAPABILITY_DESCRIPTOR_SCHEMA_VERSION),
  capabilityId: capabilityIdSchema,
  kind: capabilityKindSchema,
  runtimeOwner: capabilityRuntimeOwnerSchema,
  localName: z.string().min(1).max(160),
  sourceRef: capabilitySourceRefSchema,
  inputSchemaSha256: sha256Schema,
  effect: capabilityEffectSchema,
  scopePolicy: capabilityScopePolicySchema,
  approvalPolicy: capabilityApprovalPolicySchema,
  evidencePolicy: capabilityEvidencePolicySchema,
  readiness: capabilityReadinessSchema,
} as const;

export const capabilityDescriptorHashInputSchema = z.object(descriptorFields).strict();
export const capabilityDescriptorSchema = z
  .object({ ...descriptorFields, descriptorSha256: sha256Schema })
  .strict();

export const capabilityScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({
      kind: z.literal("workspace"),
      rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal("provider"),
      providerRef: z.string().min(1).max(200),
    })
    .strict(),
]);

/** 本次 Run 解析结果；执行、审核、Journal 与投影必须无损携带同一引用。 */
export const resolvedCapabilityRefSchema = z
  .object({
    capabilityId: capabilityIdSchema,
    descriptorSha256: sha256Schema,
    inputSchemaSha256: sha256Schema,
    resolvedImplementationSha256: sha256Schema,
    scopeRef: capabilityScopeRefSchema,
  })
  .strict();

/** 事件使用的安全显示快照；不需要再查运行时目录才能解释来源与风险。 */
export const resolvedCapabilitySnapshotSchema = z
  .object({
    ref: resolvedCapabilityRefSchema,
    localName: z.string().min(1).max(160),
    kind: capabilityKindSchema,
    runtimeOwner: capabilityRuntimeOwnerSchema,
    sourceRef: capabilitySourceRefSchema,
    effect: capabilityEffectSchema,
    scopePolicy: capabilityScopePolicySchema,
    approvalPolicy: capabilityApprovalPolicySchema,
    evidencePolicy: capabilityEvidencePolicySchema,
  })
  .strict();

export const capabilitySelectionRefSchema = z
  .object({
    capabilityId: capabilityIdSchema,
    descriptorSha256: sha256Schema,
  })
  .strict();

export type CapabilityId = z.infer<typeof capabilityIdSchema>;
export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;
export type CapabilityDescriptorHashInput = z.infer<typeof capabilityDescriptorHashInputSchema>;
export type CapabilitySourceRef = z.infer<typeof capabilitySourceRefSchema>;
export type CapabilityEffect = z.infer<typeof capabilityEffectSchema>;
export type CapabilityScopeRef = z.infer<typeof capabilityScopeRefSchema>;
export type ResolvedCapabilityRef = z.infer<typeof resolvedCapabilityRefSchema>;
export type ResolvedCapabilitySnapshot = z.infer<typeof resolvedCapabilitySnapshotSchema>;
export type CapabilitySelectionRef = z.infer<typeof capabilitySelectionRefSchema>;

export function toCapabilityDescriptorHashInput(
  descriptor: CapabilityDescriptor,
): CapabilityDescriptorHashInput {
  const { descriptorSha256: _descriptorSha256, ...input } = descriptor;
  void _descriptorSha256;
  return capabilityDescriptorHashInputSchema.parse(input);
}

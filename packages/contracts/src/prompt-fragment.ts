import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  principalIdSchema,
  promptFragmentIdSchema,
  promptFragmentRevisionIdSchema,
} from "./ids.js";

/** Prompt Region使用稳定字符串而不是封闭enum，后续增加区域不需要迁移已有产品事实。 */
export const promptRegionKeySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/u);

/**
 * Prompt Workspace只保存Chat服务端配置的rootId。DSH Workspace ID和本机绝对路径
 * 都不是产品身份，必须先在Bridge/Root Registry边界完成映射。
 */
export const promptWorkspaceRootIdSchema = z.string().regex(/^root_[A-Za-z0-9]+$/u);

export const promptFragmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({
      kind: z.literal("workspace"),
      rootId: promptWorkspaceRootIdSchema,
    })
    .strict(),
]);

export const promptFragmentContentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("markdown"),
      bodyMarkdown: z.string().trim().min(1).max(65_536),
    })
    .strict(),
  z
    .object({
      kind: z.literal("key_value"),
      key: z.string().trim().min(1).max(120),
      valueMarkdown: z.string().trim().min(1).max(65_536),
    })
    .strict(),
]);

/**
 * 派生来源冻结精确版本和Hash。Builtin正文仍由Git Catalog拥有，不复制进Product Store；
 * 用户创建副本时，Revision保存来源证据和复制后的独立正文。
 */
export const promptFragmentDerivedFromSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      promptFragmentId: promptFragmentIdSchema,
      promptFragmentRevisionId: promptFragmentRevisionIdSchema,
      revision: z.number().int().positive(),
      sha256: sha256Schema,
      sourceRelativePath: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      kind: z.literal("principal"),
      promptFragmentId: promptFragmentIdSchema,
      promptFragmentRevisionId: promptFragmentRevisionIdSchema,
      revision: z.number().int().positive(),
      sha256: sha256Schema,
    })
    .strict(),
]);

/** PromptFragmentRevision不可变；标题、描述、Region和正文的任何变化都追加Revision。 */
export const promptFragmentRevisionSchema = z
  .object({
    schemaVersion: z.literal("prompt-fragment-revision.v1"),
    promptFragmentRevisionId: promptFragmentRevisionIdSchema,
    promptFragmentId: promptFragmentIdSchema,
    revision: z.number().int().positive(),
    regionKey: promptRegionKeySchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000).optional(),
    content: promptFragmentContentSchema,
    supersedesRevisionId: promptFragmentRevisionIdSchema.optional(),
    supersedesRevisionSha256: sha256Schema.optional(),
    derivedFrom: promptFragmentDerivedFromSchema.optional(),
    authoredByPrincipalId: principalIdSchema,
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

/** Aggregate只保存所有权、生命周期、CAS和当前精确Revision；正文仅存在Revision中。 */
export const promptFragmentSchema = z
  .object({
    schemaVersion: z.literal("prompt-fragment.v1"),
    promptFragmentId: promptFragmentIdSchema,
    ownerPrincipalId: principalIdSchema,
    scope: promptFragmentScopeSchema,
    status: z.enum(["active", "archived"]),
    currentRevisionId: promptFragmentRevisionIdSchema,
    currentRevisionNumber: z.number().int().positive(),
    currentRevisionSha256: sha256Schema,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type PromptRegionKey = z.infer<typeof promptRegionKeySchema>;
export type PromptWorkspaceRootId = z.infer<typeof promptWorkspaceRootIdSchema>;
export type PromptFragmentScope = z.infer<typeof promptFragmentScopeSchema>;
export type PromptFragmentContent = z.infer<typeof promptFragmentContentSchema>;
export type PromptFragmentDerivedFrom = z.infer<typeof promptFragmentDerivedFromSchema>;
export type PromptFragmentRevision = z.infer<typeof promptFragmentRevisionSchema>;
export type PromptFragment = z.infer<typeof promptFragmentSchema>;

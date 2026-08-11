import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  commandIdSchema,
  messageIdSchema,
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  noteIdSchema,
  noteRevisionIdSchema,
  principalIdSchema,
  productRunIdSchema,
} from "./ids.js";

/**
 * Note Capture v1的显式容量合同。
 *
 * Note正文与既有Message正文采用相同字符上限；超限必须明确失败，不能静默截断。
 * 标签和来源数量保持有界，避免列表、Hash和审核表单变成无界载荷。
 */
export const NOTE_TITLE_MAX_CHARACTERS = 200;
export const NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS = 100_000;
export const NOTE_TAG_LABEL_MAX_CHARACTERS = 64;
export const NOTE_TAG_MAX_COUNT = 20;
export const NOTE_SOURCE_REF_MAX_COUNT = 20;
export const NOTE_TAG_KEY_NORMALIZATION_VERSION = "note-tag-key.nfkc-simple-fold.v1";

const isoDateTimeSchema = z.iso.datetime();
const forbiddenInlineControlCharacters = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const forbiddenMarkdownControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const safeInlineTextSchema = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !forbiddenInlineControlCharacters.test(value), {
      message: "不允许换行或控制字符",
    });

export const noteTitleSchema = safeInlineTextSchema(NOTE_TITLE_MAX_CHARACTERS);

/**
 * 合同保存Markdown源码，不把它当HTML执行。`<script>`等文本是否显示由Web安全Renderer决定；
 * NUL和不可读C0控制字符在进入产品事实前直接拒绝。
 */
export const noteContentMarkdownSchema = z
  .string()
  .min(1)
  .max(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS)
  .refine((value) => !forbiddenMarkdownControlCharacters.test(value), {
    message: "Markdown正文包含不允许的控制字符",
  })
  .refine((value) => /[^\p{C}\s]/u.test(value), {
    message: "Markdown正文必须包含可见内容",
  });

export const noteKindSchema = z.enum(["idea", "project_idea", "learning", "general"]);
export const noteStatusSchema = z.enum(["active", "archived"]);

/**
 * `key`必须由Domain的版本化Unicode规则从`label`产生；Store完整性校验负责二者关系。
 * Schema先拒绝不可安全显示的边界值，避免持久层接收控制字符或无界Tag。
 */
export const noteTagSchema = z
  .object({
    key: safeInlineTextSchema(NOTE_TAG_LABEL_MAX_CHARACTERS),
    label: safeInlineTextSchema(NOTE_TAG_LABEL_MAX_CHARACTERS),
  })
  .strict();

export const noteTagsSchema = z
  .array(noteTagSchema)
  .max(NOTE_TAG_MAX_COUNT)
  .refine((tags) => new Set(tags.map((tag) => tag.key)).size === tags.length, {
    message: "同一Note Revision不能包含重复Tag key",
  });

/**
 * Message正文仍由Message聚合拥有。Note只冻结完整Message或UTF-16选区的身份、范围和Hash；
 * 不复制来源正文，也不接受DOM Selection、文件路径或任意URL。
 */
export const noteSourceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("full_message"),
      sourceMessageId: messageIdSchema,
      sourceMessageSha256: sha256Schema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("utf16_range"),
      sourceMessageId: messageIdSchema,
      sourceMessageSha256: sha256Schema,
      startUtf16: z.number().int().nonnegative(),
      endUtf16: z.number().int().positive(),
      selectedTextSha256: sha256Schema,
    })
    .strict()
    .refine((value) => value.startUtf16 < value.endUtf16, {
      message: "UTF-16选区起点必须小于终点",
      path: ["endUtf16"],
    }),
]);

export const noteSourceRefsSchema = z
  .array(noteSourceRefSchema)
  .min(1)
  .max(NOTE_SOURCE_REF_MAX_COUNT);

export const noteDraftSchema = z
  .object({
    title: noteTitleSchema,
    kind: noteKindSchema,
    contentMarkdown: noteContentMarkdownSchema,
    tags: noteTagsSchema,
  })
  .strict();

/** Note只保存聚合身份和当前Revision引用；正文永远只存在于不可变NoteRevision。 */
export const noteSchema = z
  .object({
    schemaVersion: z.literal("note.v1"),
    noteId: noteIdSchema,
    ownerPrincipalId: principalIdSchema,
    sourceCandidateId: noteCandidateIdSchema,
    currentRevisionId: noteRevisionIdSchema,
    status: noteStatusSchema,
    revision: z.number().int().positive(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

/**
 * NoteRevision创建后逐字段不可变。`createdByPrincipalId`属于可审计产品来源；
 * Runtime、Provider、Prompt、HTML缓存和同步元数据都不属于该合同。
 */
export const noteRevisionSchema = z
  .object({
    schemaVersion: z.literal("note-revision.v1"),
    noteRevisionId: noteRevisionIdSchema,
    noteId: noteIdSchema,
    noteRevision: z.number().int().positive(),
    title: noteTitleSchema,
    kind: noteKindSchema,
    contentMarkdown: noteContentMarkdownSchema,
    tags: noteTagsSchema,
    sourceRefs: noteSourceRefsSchema,
    createdByPrincipalId: principalIdSchema,
    sha256: sha256Schema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

const noteCandidateBase = {
  schemaVersion: z.literal("note-candidate.v1"),
  noteCandidateId: noteCandidateIdSchema,
  productRunId: productRunIdSchema,
  candidateSequence: z.number().int().positive(),
  supersedesCandidateId: noteCandidateIdSchema.optional(),
  proposed: noteDraftSchema,
  sourceRefs: noteSourceRefsSchema,
  sha256: sha256Schema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

const noteCandidateFailureSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
    summary: z.string().trim().min(1).max(500),
  })
  .strict();

/** 候选正文不可变；只有status、failure、revision和updatedAt可按状态机追加变化。 */
export const noteCandidateSchema = z.discriminatedUnion("status", [
  z.object({ ...noteCandidateBase, status: z.literal("under_review") }).strict(),
  z.object({ ...noteCandidateBase, status: z.literal("confirmed") }).strict(),
  z.object({ ...noteCandidateBase, status: z.literal("revision_requested") }).strict(),
  z.object({ ...noteCandidateBase, status: z.literal("rejected") }).strict(),
  z
    .object({
      ...noteCandidateBase,
      status: z.literal("failed"),
      failure: noteCandidateFailureSchema,
    })
    .strict(),
]);

export const noteDecisionKindSchema = z.enum(["confirm", "request_revision", "reject"]);

const noteDecisionBase = {
  schemaVersion: z.literal("note-decision.v1"),
  noteDecisionId: noteDecisionIdSchema,
  productRunId: productRunIdSchema,
  noteCandidateId: noteCandidateIdSchema,
  candidateRevision: z.number().int().positive(),
  candidateSha256: sha256Schema,
  principalId: principalIdSchema,
  commandId: commandIdSchema,
  revision: z.literal(1),
  createdAt: isoDateTimeSchema,
};

/** Decision按kind严格分支，防止说明字段落在错误的决定类型上。 */
export const noteDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ ...noteDecisionBase, kind: z.literal("confirm") }).strict(),
  z
    .object({
      ...noteDecisionBase,
      kind: z.literal("request_revision"),
      revisionInstruction: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      ...noteDecisionBase,
      kind: z.literal("reject"),
      reason: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export type NoteKind = z.infer<typeof noteKindSchema>;
export type NoteStatus = z.infer<typeof noteStatusSchema>;
export type NoteTag = z.infer<typeof noteTagSchema>;
export type NoteSourceRef = z.infer<typeof noteSourceRefSchema>;
export type NoteDraft = z.infer<typeof noteDraftSchema>;
export type Note = z.infer<typeof noteSchema>;
export type NoteRevision = z.infer<typeof noteRevisionSchema>;
export type NoteCandidate = z.infer<typeof noteCandidateSchema>;
export type NoteDecisionKind = z.infer<typeof noteDecisionKindSchema>;
export type NoteDecision = z.infer<typeof noteDecisionSchema>;

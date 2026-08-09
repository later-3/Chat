import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  noteIdSchema,
  noteRevisionIdSchema,
  principalIdSchema,
  productRunIdSchema,
} from "./ids.js";
import {
  NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS,
  NOTE_TAG_LABEL_MAX_CHARACTERS,
  NOTE_TAG_MAX_COUNT,
  NOTE_TITLE_MAX_CHARACTERS,
  noteContentMarkdownSchema,
  noteKindSchema,
  noteSourceRefsSchema,
  noteStatusSchema,
  noteTagSchema,
  noteTitleSchema,
} from "./note.js";

export const NOTE_API_SCHEMA_VERSION = "chat-note-api.v1";

const tagLabelInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(NOTE_TAG_LABEL_MAX_CHARACTERS)
  .refine((value) => !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), {
    message: "Tag label不允许换行或控制字符",
  });

/**
 * 浏览器提交显示label，权威key只能由服务端Domain规范化；这避免前后端Unicode算法漂移。
 */
export const noteRevisionInputSchema = z
  .object({
    title: noteTitleSchema,
    kind: noteKindSchema,
    contentMarkdown: noteContentMarkdownSchema,
    tagLabels: z.array(tagLabelInputSchema).max(NOTE_TAG_MAX_COUNT),
  })
  .strict();

export const reviseNotePayloadSchema = z
  .object({
    currentRevisionId: noteRevisionIdSchema,
    currentRevisionSha256: sha256Schema,
    revision: noteRevisionInputSchema,
  })
  .strict();

const noteLifecyclePayloadBase = {
  currentRevisionId: noteRevisionIdSchema,
  currentRevisionSha256: sha256Schema,
};

export const archiveNotePayloadSchema = z.object(noteLifecyclePayloadBase).strict();
export const restoreNotePayloadSchema = z.object(noteLifecyclePayloadBase).strict();

const noteDecisionPayloadBase = {
  productRunId: productRunIdSchema,
  noteCandidateId: noteCandidateIdSchema,
  candidateRevision: z.number().int().positive(),
  candidateSha256: sha256Schema,
};

/**
 * edited confirm不覆盖旧Candidate；Application会先创建successor Candidate，再让Decision绑定它。
 */
export const submitNoteDecisionPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...noteDecisionPayloadBase,
      kind: z.literal("confirm"),
      editedProposal: noteRevisionInputSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...noteDecisionPayloadBase,
      kind: z.literal("request_revision"),
      revisionInstruction: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      ...noteDecisionPayloadBase,
      kind: z.literal("reject"),
      reason: z.string().trim().min(1).max(2_000).optional(),
    })
    .strict(),
]);

/** 稳定Cursor本身不透明；筛选只暴露产品枚举和canonical Tag key。 */
export const listNotesQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2_000).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    kind: noteKindSchema.optional(),
    tagKey: noteTagSchema.shape.key.optional(),
    status: noteStatusSchema.optional(),
  })
  .strict();

export const getNoteHistoryQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2_000).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const noteAllowedActionSchema = z.enum(["revise", "archive", "restore"]);
export const noteCandidateAllowedActionSchema = z.enum(["confirm", "request_revision", "reject"]);

export const noteTagDtoSchema = noteTagSchema;

export const noteRevisionSummaryDtoSchema = z
  .object({
    schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
    noteRevisionId: noteRevisionIdSchema,
    noteRevision: z.number().int().positive(),
    title: z.string().min(1).max(NOTE_TITLE_MAX_CHARACTERS),
    kind: noteKindSchema,
    tags: z.array(noteTagDtoSchema).max(NOTE_TAG_MAX_COUNT),
    sourceCount: z.number().int().min(1).max(20),
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

const noteSummaryBase = {
  schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
  noteId: noteIdSchema,
  currentRevision: noteRevisionSummaryDtoSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const noteSummaryDtoSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...noteSummaryBase,
      status: z.literal("active"),
      allowedActions: z.tuple([z.literal("revise"), z.literal("archive")]),
    })
    .strict(),
  z
    .object({
      ...noteSummaryBase,
      status: z.literal("archived"),
      allowedActions: z.tuple([z.literal("restore")]),
    })
    .strict(),
]);

export const noteRevisionDetailDtoSchema = z
  .object({
    schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
    noteRevisionId: noteRevisionIdSchema,
    noteId: noteIdSchema,
    noteRevision: z.number().int().positive(),
    title: z.string().min(1).max(NOTE_TITLE_MAX_CHARACTERS),
    kind: noteKindSchema,
    contentMarkdown: z.string().min(1).max(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS),
    tags: z.array(noteTagDtoSchema).max(NOTE_TAG_MAX_COUNT),
    sourceRefs: noteSourceRefsSchema,
    createdByPrincipalId: principalIdSchema,
    sha256: sha256Schema,
    createdAt: z.iso.datetime(),
  })
  .strict();

const noteDetailBase = {
  schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
  noteId: noteIdSchema,
  currentRevision: noteRevisionDetailDtoSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const noteDetailDtoSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...noteDetailBase,
      status: z.literal("active"),
      allowedActions: z.tuple([z.literal("revise"), z.literal("archive")]),
    })
    .strict(),
  z
    .object({
      ...noteDetailBase,
      status: z.literal("archived"),
      allowedActions: z.tuple([z.literal("restore")]),
    })
    .strict(),
]);

export const notePageDtoSchema = z
  .object({
    schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
    items: z.array(noteSummaryDtoSchema).max(200),
    nextCursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();

export const noteHistoryPageDtoSchema = z
  .object({
    schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
    items: z.array(noteRevisionDetailDtoSchema).max(200),
    nextCursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const noteCandidateReviewBase = {
  schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
  noteCandidateId: noteCandidateIdSchema,
  productRunId: productRunIdSchema,
  candidateSequence: z.number().int().positive(),
  supersedesCandidateId: noteCandidateIdSchema.optional(),
  proposed: z
    .object({
      title: z.string().min(1).max(NOTE_TITLE_MAX_CHARACTERS),
      kind: noteKindSchema,
      contentMarkdown: z.string().min(1).max(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS),
      tags: z.array(noteTagDtoSchema).max(NOTE_TAG_MAX_COUNT),
    })
    .strict(),
  sourceRefs: noteSourceRefsSchema,
  sha256: sha256Schema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/** Candidate审核DTO只含产品候选和安全来源引用，不含Prompt、Provider或Hook信息。 */
export const noteCandidateReviewDtoSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...noteCandidateReviewBase,
      status: z.literal("under_review"),
      allowedActions: z.tuple([
        z.literal("confirm"),
        z.literal("request_revision"),
        z.literal("reject"),
      ]),
    })
    .strict(),
  z
    .object({
      ...noteCandidateReviewBase,
      status: z.enum(["confirmed", "revision_requested", "rejected"]),
      allowedActions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      ...noteCandidateReviewBase,
      status: z.literal("failed"),
      failure: z
        .object({
          code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),
          summary: z.string().min(1).max(500),
        })
        .strict(),
      allowedActions: z.tuple([]),
    })
    .strict(),
]);

const noteDecisionDtoBase = {
  schemaVersion: z.literal(NOTE_API_SCHEMA_VERSION),
  noteDecisionId: noteDecisionIdSchema,
  productRunId: productRunIdSchema,
  noteCandidateId: noteCandidateIdSchema,
  candidateRevision: z.number().int().positive(),
  candidateSha256: sha256Schema,
  principalId: principalIdSchema,
  createdAt: z.iso.datetime(),
};

export const noteDecisionDtoSchema = z.discriminatedUnion("kind", [
  z.object({ ...noteDecisionDtoBase, kind: z.literal("confirm") }).strict(),
  z
    .object({
      ...noteDecisionDtoBase,
      kind: z.literal("request_revision"),
      revisionInstruction: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      ...noteDecisionDtoBase,
      kind: z.literal("reject"),
      reason: z.string().min(1).max(2_000).optional(),
    })
    .strict(),
]);

export type NoteRevisionInput = z.infer<typeof noteRevisionInputSchema>;
export type ReviseNotePayload = z.infer<typeof reviseNotePayloadSchema>;
export type ArchiveNotePayload = z.infer<typeof archiveNotePayloadSchema>;
export type RestoreNotePayload = z.infer<typeof restoreNotePayloadSchema>;
export type SubmitNoteDecisionPayload = z.infer<typeof submitNoteDecisionPayloadSchema>;
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;
export type GetNoteHistoryQuery = z.infer<typeof getNoteHistoryQuerySchema>;
export type NoteRevisionSummaryDto = z.infer<typeof noteRevisionSummaryDtoSchema>;
export type NoteSummaryDto = z.infer<typeof noteSummaryDtoSchema>;
export type NoteRevisionDetailDto = z.infer<typeof noteRevisionDetailDtoSchema>;
export type NoteDetailDto = z.infer<typeof noteDetailDtoSchema>;
export type NotePageDto = z.infer<typeof notePageDtoSchema>;
export type NoteHistoryPageDto = z.infer<typeof noteHistoryPageDtoSchema>;
export type NoteCandidateReviewDto = z.infer<typeof noteCandidateReviewDtoSchema>;
export type NoteDecisionDto = z.infer<typeof noteDecisionDtoSchema>;

import {
  commandEnvelopeSchema,
  createRulePayloadSchema,
  createRuleTagPayloadSchema,
  noteCandidateReviewDtoSchema,
  noteDecisionDtoSchema,
  noteDetailDtoSchema,
  noteHistoryPageDtoSchema,
  notePageDtoSchema,
  noteRevisionInputSchema,
  reviseRulePayloadSchema,
  ruleCommandResultDtoSchema,
  ruleDetailResponseDtoSchema,
  rulePageDtoSchema,
  ruleTagCommandResultDtoSchema,
  ruleTagsDtoSchema,
  transitionRulePayloadSchema,
  updateRuleTagPayloadSchema,
  type ArchiveNotePayload,
  type CommandId,
  type CreateRulePayload,
  type CreateRuleTagPayload,
  type NoteCandidateReviewDto,
  type NoteDecisionDto,
  type NoteDetailDto,
  type NoteHistoryPageDto,
  type NotePageDto,
  type RestoreNotePayload,
  type ReviseNotePayload,
  type ReviseRulePayload,
  type RuleCommandResultDto,
  type RuleDetailResponseDto,
  type RulePageDto,
  type RuleTagCommandResultDto,
  type RuleTagsDto,
  type SubmitNoteDecisionPayload,
  type TransitionRulePayload,
  type UpdateRuleTagPayload,
} from "@chat/contracts/public";
import { z } from "zod";
import { getWorkflowProjection, post } from "./transport.js";

const noteDecisionResponseSchema = z
  .object({ candidate: noteCandidateReviewDtoSchema, decision: noteDecisionDtoSchema })
  .strict();
const noteDetailResponseSchema = z.object({ note: noteDetailDtoSchema }).strict();

export function apiListRules(signal?: AbortSignal): Promise<RulePageDto> {
  return getWorkflowProjection("/api/rules", (json) => rulePageDtoSchema.parse(json), signal);
}

export function apiGetRule(ruleId: string, signal?: AbortSignal): Promise<RuleDetailResponseDto> {
  return getWorkflowProjection(
    `/api/rules/${encodeURIComponent(ruleId)}`,
    (json) => ruleDetailResponseDtoSchema.parse(json),
    signal,
  );
}

export function apiCreateRule(input: {
  readonly commandId: CommandId;
  readonly payload: CreateRulePayload;
}): Promise<RuleCommandResultDto> {
  return post(
    "/api/rules",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: createRulePayloadSchema.parse(input.payload),
    }),
    (json) => ruleCommandResultDtoSchema.parse(json),
  );
}

export function apiReviseRule(input: {
  readonly ruleId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: ReviseRulePayload;
}): Promise<RuleCommandResultDto> {
  return post(
    `/api/rules/${encodeURIComponent(input.ruleId)}/revisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: reviseRulePayloadSchema.parse(input.payload),
    }),
    (json) => ruleCommandResultDtoSchema.parse(json),
  );
}

export function apiTransitionRule(input: {
  readonly ruleId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: TransitionRulePayload;
}): Promise<RuleCommandResultDto> {
  return post(
    `/api/rules/${encodeURIComponent(input.ruleId)}/lifecycle`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: transitionRulePayloadSchema.parse(input.payload),
    }),
    (json) => ruleCommandResultDtoSchema.parse(json),
  );
}

export function apiListRuleTags(signal?: AbortSignal): Promise<RuleTagsDto> {
  return getWorkflowProjection("/api/rule-tags", (json) => ruleTagsDtoSchema.parse(json), signal);
}

export function apiCreateRuleTag(input: {
  readonly commandId: CommandId;
  readonly payload: CreateRuleTagPayload;
}): Promise<RuleTagCommandResultDto> {
  return post(
    "/api/rule-tags",
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      payload: createRuleTagPayloadSchema.parse(input.payload),
    }),
    (json) => ruleTagCommandResultDtoSchema.parse(json),
  );
}

export function apiUpdateRuleTag(input: {
  readonly ruleTagId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: UpdateRuleTagPayload;
}): Promise<RuleTagCommandResultDto> {
  return post(
    `/api/rule-tags/${encodeURIComponent(input.ruleTagId)}`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: updateRuleTagPayloadSchema.parse(input.payload),
    }),
    (json) => ruleTagCommandResultDtoSchema.parse(json),
  );
}

export function apiArchiveRuleTag(input: {
  readonly ruleTagId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
}): Promise<RuleTagCommandResultDto> {
  return post(
    `/api/rule-tags/${encodeURIComponent(input.ruleTagId)}/archive`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: {},
    }),
    (json) => ruleTagCommandResultDtoSchema.parse(json),
  );
}

/** Note Query只接受有限筛选；cursor始终由服务端产生且不在浏览器解析。 */
export function apiListNotes(input: {
  readonly cursor?: string;
  readonly kind?: NoteDetailDto["currentRevision"]["kind"];
  readonly tagKey?: string;
  readonly status?: NoteDetailDto["status"];
  readonly signal?: AbortSignal;
}): Promise<NotePageDto> {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  if (input.kind !== undefined) query.set("kind", input.kind);
  if (input.tagKey !== undefined) query.set("tagKey", input.tagKey);
  if (input.status !== undefined) query.set("status", input.status);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return getWorkflowProjection(
    `/api/notes${suffix}`,
    (json) => notePageDtoSchema.parse(json),
    input.signal,
  );
}

export function apiGetNote(noteId: string, signal?: AbortSignal): Promise<NoteDetailDto> {
  return getWorkflowProjection(
    `/api/notes/${encodeURIComponent(noteId)}`,
    (json) => noteDetailDtoSchema.parse(json),
    signal,
  );
}

export function apiGetNoteHistory(input: {
  readonly noteId: string;
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}): Promise<NoteHistoryPageDto> {
  const query =
    input.cursor === undefined ? "" : `?${new URLSearchParams({ cursor: input.cursor })}`;
  return getWorkflowProjection(
    `/api/notes/${encodeURIComponent(input.noteId)}/history${query}`,
    (json) => noteHistoryPageDtoSchema.parse(json),
    input.signal,
  );
}

export function apiGetCurrentNoteCandidate(
  productRunId: string,
  signal?: AbortSignal,
): Promise<NoteCandidateReviewDto> {
  return getWorkflowProjection(
    `/api/runs/${encodeURIComponent(productRunId)}/note-candidates/current`,
    (json) => noteCandidateReviewDtoSchema.parse(json),
    signal,
  );
}

export function apiReviseNote(input: {
  readonly noteId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: ReviseNotePayload;
}): Promise<NoteDetailDto> {
  return post(
    `/api/notes/${encodeURIComponent(input.noteId)}/revisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: {
        ...input.payload,
        revision: noteRevisionInputSchema.parse(input.payload.revision),
      },
    }),
    (json) => noteDetailResponseSchema.parse(json).note,
  );
}

function noteLifecycleCommand(
  path: string,
  input: {
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly payload: ArchiveNotePayload | RestoreNotePayload;
  },
): Promise<NoteDetailDto> {
  return post(
    path,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
    }),
    (json) => noteDetailResponseSchema.parse(json).note,
  );
}

export function apiArchiveNote(input: {
  readonly noteId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: ArchiveNotePayload;
}): Promise<NoteDetailDto> {
  return noteLifecycleCommand(`/api/notes/${encodeURIComponent(input.noteId)}/archive`, input);
}

export function apiRestoreNote(input: {
  readonly noteId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: RestoreNotePayload;
}): Promise<NoteDetailDto> {
  return noteLifecycleCommand(`/api/notes/${encodeURIComponent(input.noteId)}/restore`, input);
}

export function apiSubmitNoteDecision(input: {
  readonly productRunId: string;
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: SubmitNoteDecisionPayload;
}): Promise<{ candidate: NoteCandidateReviewDto; decision: NoteDecisionDto }> {
  return post(
    `/api/runs/${encodeURIComponent(input.productRunId)}/note-decisions`,
    commandEnvelopeSchema.parse({
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      payload: input.payload,
    }),
    (json) => noteDecisionResponseSchema.parse(json),
  );
}

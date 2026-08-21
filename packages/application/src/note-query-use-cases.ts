import {
  noteCandidateReviewDtoSchema,
  noteDecisionDtoSchema,
  noteDetailDtoSchema,
  noteHistoryPageDtoSchema,
  notePageDtoSchema,
  noteRevisionDetailDtoSchema,
  type GetNoteHistoryQuery,
  type ListNotesQuery,
  type Note,
  type NoteCandidate,
  type NoteCandidateReviewDto,
  type NoteDecision,
  type NoteDecisionDto,
  type NoteDetailDto,
  type NoteHistoryPageDto,
  type NoteId,
  type NotePageDto,
  type NoteRevision,
  type NoteRevisionDetailDto,
  type NoteSummaryDto,
  type PrincipalId,
  type ProductRunId,
  type ProductSnapshot,
} from "@chat/contracts";
import type { ApplicationDeps } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";
import { deriveNoteCaptureInputFromRunSpec, latestCandidate } from "./note-candidate-policy.js";
import { requireNoteCaptureRun, type NoteCaptureProductRun } from "./product-run-kind.js";
import { workflowNodePromptFor } from "./prompt-assembly-use-cases.js";

/**
 * Note公开Query与DTO投影只读取已提交快照，不拥有事务，也不推导新的产品事实。
 * Command用例复用这里的Owner检查和DTO映射，避免查询形状与写后返回形状逐渐漂移。
 */
export function assertNoteOwnerAccess(
  snapshot: { readonly entities: { readonly notes: Record<string, Note> } },
  noteId: NoteId,
  principalId: PrincipalId,
): Note {
  const note = snapshot.entities.notes[noteId];
  if (note === undefined) throw notFound("Note不存在");
  if (note.ownerPrincipalId !== principalId) throw forbidden("无权访问该Note");
  return note;
}

export function noteCurrentRevision(snapshot: ProductSnapshot, note: Note): NoteRevision {
  const revision = snapshot.entities.noteRevisions[note.currentRevisionId];
  if (revision === undefined) throw notFound("Note Revision不存在");
  return revision;
}

export function toRevisionDetail(revision: NoteRevision): NoteRevisionDetailDto {
  return noteRevisionDetailDtoSchema.parse({
    schemaVersion: "chat-note-api.v1" as const,
    noteRevisionId: revision.noteRevisionId,
    noteId: revision.noteId,
    noteRevision: revision.noteRevision,
    title: revision.title,
    kind: revision.kind,
    contentMarkdown: revision.contentMarkdown,
    tags: revision.tags.map((tag) => ({ ...tag })),
    sourceRefs: revision.sourceRefs.map((ref) => ({ ...ref })),
    createdByPrincipalId: revision.createdByPrincipalId,
    sha256: revision.sha256,
    createdAt: revision.createdAt,
  });
}

export function toNoteDetail(note: Note, revision: NoteRevision): NoteDetailDto {
  return noteDetailDtoSchema.parse({
    schemaVersion: "chat-note-api.v1",
    noteId: note.noteId,
    status: note.status,
    currentRevision: toRevisionDetail(revision),
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    allowedActions: note.status === "active" ? ["revise", "archive"] : ["restore"],
  });
}

function toNoteSummary(note: Note, revision: NoteRevision): NoteSummaryDto {
  const base = {
    schemaVersion: "chat-note-api.v1" as const,
    noteId: note.noteId,
    currentRevision: {
      schemaVersion: "chat-note-api.v1" as const,
      noteRevisionId: revision.noteRevisionId,
      noteRevision: revision.noteRevision,
      title: revision.title,
      kind: revision.kind,
      tags: revision.tags.map((tag) => ({ ...tag })),
      sourceCount: revision.sourceRefs.length,
      sha256: revision.sha256,
      createdAt: revision.createdAt,
    },
    revision: note.revision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  return note.status === "active"
    ? { ...base, status: "active", allowedActions: ["revise", "archive"] }
    : { ...base, status: "archived", allowedActions: ["restore"] };
}

export function toCandidateReview(candidate: NoteCandidate): NoteCandidateReviewDto {
  return noteCandidateReviewDtoSchema.parse({
    schemaVersion: "chat-note-api.v1",
    noteCandidateId: candidate.noteCandidateId,
    productRunId: candidate.productRunId,
    candidateSequence: candidate.candidateSequence,
    ...(candidate.supersedesCandidateId !== undefined
      ? { supersedesCandidateId: candidate.supersedesCandidateId }
      : {}),
    proposed: {
      title: candidate.proposed.title,
      kind: candidate.proposed.kind,
      contentMarkdown: candidate.proposed.contentMarkdown,
      tags: candidate.proposed.tags.map((tag) => ({ ...tag })),
    },
    sourceRefs: candidate.sourceRefs.map((ref) => ({ ...ref })),
    status: candidate.status,
    ...(candidate.status === "failed" ? { failure: candidate.failure } : {}),
    sha256: candidate.sha256,
    revision: candidate.revision,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    allowedActions:
      candidate.status === "under_review" ? ["confirm", "request_revision", "reject"] : [],
  });
}

export function toDecisionDto(decision: NoteDecision): NoteDecisionDto {
  return noteDecisionDtoSchema.parse({
    schemaVersion: "chat-note-api.v1",
    noteDecisionId: decision.noteDecisionId,
    productRunId: decision.productRunId,
    noteCandidateId: decision.noteCandidateId,
    candidateRevision: decision.candidateRevision,
    candidateSha256: decision.candidateSha256,
    principalId: decision.principalId,
    kind: decision.kind,
    ...(decision.kind === "request_revision"
      ? { revisionInstruction: decision.revisionInstruction }
      : {}),
    ...(decision.kind === "reject" && decision.reason !== undefined
      ? { reason: decision.reason }
      : {}),
    createdAt: decision.createdAt,
  });
}

export async function listNotes(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly query: ListNotesQuery },
): Promise<{ readonly notes: NotePageDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const limit = input.query.limit ?? 50;
  const after = input.query.cursor ?? "";
  const rows = Object.values(snapshot.entities.notes)
    .filter((note) => note.ownerPrincipalId === input.principalId)
    .filter((note) => input.query.status === undefined || note.status === input.query.status)
    .map((note) => ({ note, revision: noteCurrentRevision(snapshot, note) }))
    .filter(({ revision }) => input.query.kind === undefined || revision.kind === input.query.kind)
    .filter(
      ({ revision }) =>
        input.query.tagKey === undefined ||
        revision.tags.some((tag) => tag.key === input.query.tagKey),
    )
    .sort((left, right) =>
      right.note.updatedAt === left.note.updatedAt
        ? left.note.noteId.localeCompare(right.note.noteId)
        : right.note.updatedAt.localeCompare(left.note.updatedAt),
    );
  const start =
    after === ""
      ? 0
      : rows.findIndex(({ note }) => `${note.updatedAt}|${note.noteId}` === after) + 1;
  if (start < 0) throw revisionConflict("Note列表cursor已过期，请重新读取");
  const page = rows.slice(start, start + limit + 1);
  const items = page.slice(0, limit).map(({ note, revision }) => toNoteSummary(note, revision));
  const last = page[limit - 1];
  return {
    notes: notePageDtoSchema.parse({
      schemaVersion: "chat-note-api.v1",
      items,
      ...(page.length > limit && last !== undefined
        ? { nextCursor: `${last.note.updatedAt}|${last.note.noteId}` }
        : {}),
    }),
  };
}

export async function getNote(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly noteId: NoteId },
): Promise<{ readonly note: NoteDetailDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const note = assertNoteOwnerAccess(snapshot, input.noteId, input.principalId);
  return { note: toNoteDetail(note, noteCurrentRevision(snapshot, note)) };
}

export async function getNoteHistory(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly noteId: NoteId;
    readonly query: GetNoteHistoryQuery;
  },
): Promise<{ readonly history: NoteHistoryPageDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const note = assertNoteOwnerAccess(snapshot, input.noteId, input.principalId);
  const limit = input.query.limit ?? 50;
  const after = input.query.cursor ?? "";
  const rows = Object.values(snapshot.entities.noteRevisions)
    .filter((revision) => revision.noteId === note.noteId)
    .sort((left, right) => right.noteRevision - left.noteRevision);
  const start =
    after === "" ? 0 : rows.findIndex((revision) => revision.noteRevisionId === after) + 1;
  if (start < 0) throw revisionConflict("Note历史cursor已过期，请重新读取");
  const page = rows.slice(start, start + limit + 1);
  const items = page.slice(0, limit).map(toRevisionDetail);
  const last = page[limit - 1];
  return {
    history: noteHistoryPageDtoSchema.parse({
      schemaVersion: "chat-note-api.v1",
      items,
      ...(page.length > limit && last !== undefined ? { nextCursor: last.noteRevisionId } : {}),
    }),
  };
}

export async function getCurrentNoteCandidate(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
): Promise<{ readonly candidate: NoteCandidateReviewDto | null }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const noteRun = requireNoteCaptureRun(run);
  const session = snapshot.entities.sessions[noteRun.sessionId];
  if (session?.ownerPrincipalId !== input.principalId) throw forbidden("无权访问该Note候选");
  const candidate = Object.values(snapshot.entities.noteCandidates)
    .filter((item) => item.productRunId === input.productRunId)
    .sort((left, right) => right.candidateSequence - left.candidateSequence)[0];
  return { candidate: candidate === undefined ? null : toCandidateReview(candidate) };
}

export async function prepareNoteCaptureInputForRuntime(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: NonNullable<NoteCaptureProductRun["workflowRunSpecId"]>;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const noteRun = requireNoteCaptureRun(run);
  if (noteRun.workflowRunSpecId !== input.workflowRunSpecId) {
    throw revisionConflict("Note Capture Input加载的RunSpec与Run绑定不一致");
  }
  const prepared = deriveNoteCaptureInputFromRunSpec(snapshot.entities, noteRun);
  const nodePrompt = workflowNodePromptFor(snapshot, input.productRunId, "note.extract");
  const priorCandidate = latestCandidate(
    snapshot.entities,
    input.productRunId,
    "revision_requested",
  );
  const priorDecision =
    priorCandidate === undefined
      ? undefined
      : Object.values(snapshot.entities.noteDecisions)
          .filter(
            (decision) =>
              decision.productRunId === input.productRunId &&
              decision.noteCandidateId === priorCandidate.noteCandidateId &&
              decision.kind === "request_revision",
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return {
    ...prepared,
    ...(nodePrompt === undefined ? {} : { nodePrompt }),
    ...(priorCandidate === undefined ? {} : { priorCandidate: toCandidateReview(priorCandidate) }),
    ...(priorDecision?.kind === "request_revision"
      ? { revisionInstruction: priorDecision.revisionInstruction }
      : {}),
  };
}

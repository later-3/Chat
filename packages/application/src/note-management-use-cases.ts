import {
  noteRevisionSchema,
  type ArchiveNotePayload,
  type NoteDetailDto,
  type NoteId,
  type PrincipalId,
  type RestoreNotePayload,
  type ReviseNotePayload,
} from "@chat/contracts";
import {
  assertNoteCanRevise,
  assertNoteLifecycleTransition,
  assertNoteRevisionAppend,
  computeNoteRevisionSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import {
  assertNoteOwnerAccess,
  noteCurrentRevision,
  toNoteDetail,
} from "./note-query-use-cases.js";
import { normalizeNoteRevisionInput } from "./note-revision-helpers.js";

type CommandId = Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];

/** 普通Note聚合维护与Workflow Candidate生命周期分离；每个Command仍拥有单一事务。 */
export async function reviseNote(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly noteId: NoteId;
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly payload: ReviseNotePayload;
  },
): Promise<{ readonly note: NoteDetailDto }> {
  if (deps.noteIds === undefined) throw new Error("NoteIdFactory未配置，不能执行Note用例");
  const now = deps.now();
  const requestSha256 = hashCanonical("command.revise-note.v1", input);
  const nextRevisionId = deps.noteIds.revision();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ReviseNote",
    requestSha256,
    mutate: (draft) => {
      const note = assertNoteOwnerAccess(draft, input.noteId, input.principalId);
      if (note.revision !== input.expectedRevision) throw revisionConflict("Note revision已变化");
      assertNoteCanRevise(note);
      const current = draft.entities.noteRevisions[input.payload.currentRevisionId];
      if (current === undefined || current.noteId !== note.noteId) {
        throw revisionConflict("当前Revision不存在");
      }
      if (
        current.sha256 !== input.payload.currentRevisionSha256 ||
        current.noteRevisionId !== note.currentRevisionId
      ) {
        throw revisionConflict("Note Revision已变化");
      }
      const normalized = normalizeNoteRevisionInput(input.payload.revision);
      const next = noteRevisionSchema.parse({
        schemaVersion: "note-revision.v1",
        noteRevisionId: nextRevisionId,
        noteId: note.noteId,
        noteRevision: current.noteRevision + 1,
        ...normalized,
        sourceRefs: current.sourceRefs.map((ref) => ({ ...ref })),
        createdByPrincipalId: input.principalId,
        sha256: computeNoteRevisionSha256({
          noteId: note.noteId,
          noteRevision: current.noteRevision + 1,
          ...normalized,
          sourceRefs: current.sourceRefs,
          createdByPrincipalId: input.principalId,
        }),
        createdAt: now,
      });
      assertNoteRevisionAppend({ current, next });
      draft.entities.noteRevisions[nextRevisionId] = next;
      draft.entities.notes[note.noteId] = {
        ...note,
        currentRevisionId: nextRevisionId,
        revision: note.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { noteId: note.noteId, noteRevisionId: nextRevisionId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const note = snapshot.entities.notes[result.resultRefs["noteId"] ?? ""];
  if (note === undefined) throw notFound("Note不存在");
  return { note: toNoteDetail(note, noteCurrentRevision(snapshot, note)) };
}

async function setNoteArchiveStatus(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly noteId: NoteId;
    readonly commandId: CommandId;
    readonly expectedRevision: number;
    readonly payload: ArchiveNotePayload | RestoreNotePayload;
    readonly status: "active" | "archived";
    readonly commandType: "ArchiveNote" | "RestoreNote";
  },
): Promise<{ readonly note: NoteDetailDto }> {
  const now = deps.now();
  const requestSha256 = hashCanonical(`command.${input.commandType}.v1`, input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: input.commandType,
    requestSha256,
    mutate: (draft) => {
      const note = assertNoteOwnerAccess(draft, input.noteId, input.principalId);
      if (note.revision !== input.expectedRevision) throw revisionConflict("Note revision已变化");
      const current = draft.entities.noteRevisions[input.payload.currentRevisionId];
      if (
        current === undefined ||
        current.noteId !== note.noteId ||
        current.sha256 !== input.payload.currentRevisionSha256 ||
        current.noteRevisionId !== note.currentRevisionId
      ) {
        throw revisionConflict("Note Revision已变化");
      }
      assertNoteLifecycleTransition(note.status, input.status);
      draft.entities.notes[note.noteId] = {
        ...note,
        status: input.status,
        revision: note.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { noteId: note.noteId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const note = snapshot.entities.notes[result.resultRefs["noteId"] ?? ""];
  if (note === undefined) throw notFound("Note不存在");
  return { note: toNoteDetail(note, noteCurrentRevision(snapshot, note)) };
}

export const archiveNote = (
  deps: ApplicationDeps,
  input: Omit<Parameters<typeof setNoteArchiveStatus>[1], "status" | "commandType">,
) => setNoteArchiveStatus(deps, { ...input, status: "archived", commandType: "ArchiveNote" });

export const restoreNote = (
  deps: ApplicationDeps,
  input: Omit<Parameters<typeof setNoteArchiveStatus>[1], "status" | "commandType">,
) => setNoteArchiveStatus(deps, { ...input, status: "active", commandType: "RestoreNote" });

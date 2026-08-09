import {
  archiveNotePayloadSchema,
  commandIdSchema,
  noteRevisionInputSchema,
  restoreNotePayloadSchema,
  reviseNotePayloadSchema,
  submitNoteDecisionPayloadSchema,
  type ArchiveNotePayload,
  type CommandId,
  type NoteRevisionInput,
  type RestoreNotePayload,
  type ReviseNotePayload,
  type SubmitNoteDecisionPayload,
} from "@chat/contracts/public";

const PREFIX = "chat:note-draft:v1:";

export function noteReviewDraftKey(sessionId: string, productRunId: string): string {
  return `${PREFIX}review:${sessionId}:${productRunId}`;
}

export function noteRevisionDraftKey(sessionId: string, noteId: string): string {
  return `${PREFIX}revision:${sessionId}:${noteId}`;
}

export function pendingNoteDecisionKey(sessionId: string, productRunId: string): string {
  return `${PREFIX}pending-decision:${sessionId}:${productRunId}`;
}

export function pendingNoteMutationKey(sessionId: string, noteId: string): string {
  return `${PREFIX}pending-mutation:${sessionId}:${noteId}`;
}

function read<T>(storage: Storage, key: string, parse: (value: unknown) => T | null): T | null {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 草稿不可用不影响服务端事实或命令幂等。
  }
}

export function readNoteRevisionDraft(storage: Storage, key: string): NoteRevisionInput | null {
  return read(storage, key, (value) => noteRevisionInputSchema.safeParse(value).data ?? null);
}

export function writeNoteRevisionDraft(
  storage: Storage,
  key: string,
  draft: NoteRevisionInput,
): void {
  const parsed = noteRevisionInputSchema.safeParse(draft);
  if (parsed.success) write(storage, key, parsed.data);
}

export interface PendingNoteDecision {
  readonly commandId: CommandId;
  readonly expectedRevision: number;
  readonly payload: SubmitNoteDecisionPayload;
}

export function readPendingNoteDecision(storage: Storage, key: string): PendingNoteDecision | null {
  return read(storage, key, (value) => {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const payload = submitNoteDecisionPayloadSchema.safeParse(record.payload);
    const commandId = commandIdSchema.safeParse(record.commandId);
    return commandId.success && typeof record.expectedRevision === "number" && payload.success
      ? {
          commandId: commandId.data,
          expectedRevision: record.expectedRevision,
          payload: payload.data,
        }
      : null;
  });
}

export function writePendingNoteDecision(
  storage: Storage,
  key: string,
  pending: PendingNoteDecision,
): void {
  const payload = submitNoteDecisionPayloadSchema.safeParse(pending.payload);
  if (payload.success) write(storage, key, { ...pending, payload: payload.data });
}

export type PendingNoteMutation =
  | {
      readonly kind: "revise";
      readonly commandId: CommandId;
      readonly expectedRevision: number;
      readonly payload: ReviseNotePayload;
    }
  | {
      readonly kind: "archive";
      readonly commandId: CommandId;
      readonly expectedRevision: number;
      readonly payload: ArchiveNotePayload;
    }
  | {
      readonly kind: "restore";
      readonly commandId: CommandId;
      readonly expectedRevision: number;
      readonly payload: RestoreNotePayload;
    };

export function readPendingNoteMutation(storage: Storage, key: string): PendingNoteMutation | null {
  return read(storage, key, (value) => {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const commandId = commandIdSchema.safeParse(record.commandId);
    if (
      !commandId.success ||
      !Number.isInteger(record.expectedRevision) ||
      (record.expectedRevision as number) < 1
    ) {
      return null;
    }
    const common = {
      commandId: commandId.data,
      expectedRevision: record.expectedRevision as number,
    };
    if (record.kind === "revise") {
      const payload = reviseNotePayloadSchema.safeParse(record.payload);
      return payload.success ? { kind: record.kind, ...common, payload: payload.data } : null;
    }
    if (record.kind === "archive") {
      const payload = archiveNotePayloadSchema.safeParse(record.payload);
      return payload.success ? { kind: record.kind, ...common, payload: payload.data } : null;
    }
    if (record.kind === "restore") {
      const payload = restoreNotePayloadSchema.safeParse(record.payload);
      return payload.success ? { kind: record.kind, ...common, payload: payload.data } : null;
    }
    return null;
  });
}

export function writePendingNoteMutation(
  storage: Storage,
  key: string,
  pending: PendingNoteMutation,
): void {
  const payloadSchema =
    pending.kind === "revise"
      ? reviseNotePayloadSchema
      : pending.kind === "archive"
        ? archiveNotePayloadSchema
        : restoreNotePayloadSchema;
  const commandId = commandIdSchema.safeParse(pending.commandId);
  const payload = payloadSchema.safeParse(pending.payload);
  if (commandId.success && payload.success && pending.expectedRevision > 0) {
    write(storage, key, { ...pending, commandId: commandId.data, payload: payload.data });
  }
}

export function clearNoteDraft(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // 同上。
  }
}

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  NOTE_API_SCHEMA_VERSION,
  type NoteCandidateReviewDto,
  type NoteDetailDto,
  type NoteHistoryPageDto,
  type NotePageDto,
} from "@chat/contracts/public";
import {
  apiGetCurrentNoteCandidate,
  apiGetNote,
  apiGetNoteHistory,
  apiListNotes,
} from "../api/client.js";

const NOTE_STALE_MS = 1_000;

export const notesQueryKey = (input: {
  cursor?: string;
  kind?: string;
  tagKey?: string;
  status?: string;
}) => [NOTE_API_SCHEMA_VERSION, "notes", input] as const;

export function useNotes(input: {
  readonly cursor?: string;
  readonly kind?: "idea" | "project_idea" | "learning" | "general";
  readonly tagKey?: string;
  readonly status?: "active" | "archived";
}): UseQueryResult<NotePageDto> {
  return useQuery({
    queryKey: notesQueryKey(input),
    queryFn: ({ signal }) => apiListNotes({ ...input, signal }),
    staleTime: NOTE_STALE_MS,
    refetchOnReconnect: true,
  });
}

export function useNote(noteId: string | null): UseQueryResult<NoteDetailDto> {
  return useQuery({
    queryKey: [NOTE_API_SCHEMA_VERSION, "note", noteId],
    enabled: noteId !== null,
    queryFn: ({ signal }) => apiGetNote(noteId ?? "", signal),
    staleTime: NOTE_STALE_MS,
    refetchOnReconnect: true,
  });
}

export function useNoteHistory(input: {
  readonly noteId: string | null;
  readonly cursor?: string;
}): UseQueryResult<NoteHistoryPageDto> {
  return useQuery({
    queryKey: [NOTE_API_SCHEMA_VERSION, "note-history", input.noteId, input.cursor],
    enabled: input.noteId !== null,
    queryFn: ({ signal }) =>
      apiGetNoteHistory({
        noteId: input.noteId ?? "",
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        signal,
      }),
    staleTime: NOTE_STALE_MS,
    refetchOnReconnect: true,
  });
}

export function useCurrentNoteCandidate(
  productRunId: string | null,
  active: boolean,
): UseQueryResult<NoteCandidateReviewDto> {
  return useQuery({
    queryKey: [NOTE_API_SCHEMA_VERSION, "note-candidate", productRunId],
    enabled: productRunId !== null,
    queryFn: ({ signal }) => apiGetCurrentNoteCandidate(productRunId ?? "", signal),
    refetchInterval: active ? 1_500 : false,
    refetchIntervalInBackground: false,
    staleTime: NOTE_STALE_MS,
    refetchOnReconnect: true,
  });
}

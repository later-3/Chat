import type { NoteRevisionInput } from "@chat/contracts";
import { normalizeNoteTags, normalizeNoteTitle } from "@chat/domain";

/** 把公开输入规范化成进入Note聚合Hash与Revision的唯一形状。 */
export function normalizeNoteRevisionInput(input: NoteRevisionInput) {
  return {
    title: normalizeNoteTitle(input.title),
    kind: input.kind,
    contentMarkdown: input.contentMarkdown,
    tags: normalizeNoteTags(input.tagLabels),
  };
}

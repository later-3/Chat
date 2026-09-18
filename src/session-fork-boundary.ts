/** Copied entries remain history, but their live controls belong to the source Session. */
export const CHAT_SESSION_FORK = "chat.session_fork";

export function ownSessionEntries<T>(entries: readonly T[]): readonly T[] {
  const boundary = entries.findLastIndex((entry) => (
    typeof entry === "object" && entry !== null && "type" in entry && entry.type === "custom"
    && "customType" in entry && entry.customType === CHAT_SESSION_FORK
  ));
  return boundary < 0 ? entries : entries.slice(boundary + 1);
}

import { createHash } from "node:crypto";

/**
 * The trusted request identity for one Long Agent turn (plus its fork selection). Kept in a dependency-
 * light module so the Pi Tool can derive it without importing the Workflow startup graph.
 */
export function topicCreationRequestForTurn(
  turnId: string,
  parents: readonly { readonly nodeId: string; readonly anchorEntryId: string; readonly anchorSequence: number }[],
): string {
  if (turnId.trim() === "") throw new Error("主题创建需要当前可信轮次身份");
  return `topic-req:${createHash("sha256").update(JSON.stringify([turnId, parents])).digest("hex").slice(0, 32)}`;
}

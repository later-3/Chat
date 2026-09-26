import { createHash } from "node:crypto";
import type { ChatWorkflowInput } from "../types.js";

/** Identity only. The Run and its native prepare Session own progress, drafts and approval. */
export interface TopicCreationBinding {
  readonly requestId: string;
  readonly sourceSessionId: string;
  readonly requestFingerprint: string;
}

export function parseTopicCreationParents(value: unknown): NonNullable<ChatWorkflowInput["topicCreation"]>["parents"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("分叉来源必须是数组");
  return value.map((candidate: unknown) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("分叉来源无效");
    const parent = candidate as Record<string, unknown>;
    if (Object.keys(parent).some(key => !["nodeId", "anchorEntryId", "anchorSequence"].includes(key))
      || typeof parent.nodeId !== "string" || !parent.nodeId.trim()
      || typeof parent.anchorEntryId !== "string" || !parent.anchorEntryId.trim()
      || typeof parent.anchorSequence !== "number" || !Number.isSafeInteger(parent.anchorSequence) || parent.anchorSequence < 1) {
      throw new Error("分叉来源或已完成轮次无效");
    }
    return { nodeId: parent.nodeId, anchorEntryId: parent.anchorEntryId, anchorSequence: parent.anchorSequence };
  });
}

export function topicCreationBinding(prompt: string, target: NonNullable<ChatWorkflowInput["topicCreation"]>): TopicCreationBinding {
  return {
    requestId: target.requestId,
    sourceSessionId: target.sourceSessionId,
    requestFingerprint: createHash("sha256").update(JSON.stringify([
      target.longAgentId, target.requestId, target.sourceSessionId, target.sourceTurnId, prompt,
      target.parents.map(parent => [parent.nodeId, parent.anchorEntryId, parent.anchorSequence]),
    ])).digest("hex"),
  };
}

export function parseTopicCreationBinding(value: unknown): TopicCreationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("主题创建绑定无效");
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || record.requestId.trim() === ""
    || typeof record.sourceSessionId !== "string" || record.sourceSessionId.trim() === ""
    || typeof record.requestFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.requestFingerprint)) {
    throw new Error("主题创建绑定无效");
  }
  return { requestId: record.requestId, sourceSessionId: record.sourceSessionId, requestFingerprint: record.requestFingerprint };
}

import { Type } from "@earendil-works/pi-ai";
import {
  MEMORY_KINDS,
  type MemoryRecord,
  type MemoryTarget,
} from "../../../memory/types.js";

export const memoryKindSchema = Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)));

export const memoryTargetSchema = Type.Union([
  Type.Object({ type: Type.Literal("personal") }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("project"),
    projectId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

export function normalizeMemoryTarget(
  value: { type: "personal" } | { type: "project"; projectId: string },
): MemoryTarget {
  return value.type === "personal"
    ? { type: "personal" }
    : { type: "project", projectId: value.projectId };
}

function targetForRecord(record: MemoryRecord): MemoryTarget {
  return record.scope === "personal"
    ? { type: "personal" }
    : { type: "project", projectId: record.projectId as string };
}

export function memorySummary(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    target: targetForRecord(record),
    groupId: record.groupId,
    text: record.text,
    kind: record.kind,
    scope: record.scope,
    projectId: record.projectId,
    sourceProjectId: record.sourceProjectId,
    sourceSessionId: record.sourceSessionId,
    status: record.status,
    version: record.version,
    indexStatus: record.indexStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function memoryResultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function throwIfMemoryToolAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Memory operation aborted");
}

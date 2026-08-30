import { createError } from "nitro/h3";
import {
  MemoryIndexError,
  MemoryNotFoundError,
  MemoryValidationError,
} from "./service.js";
import {
  MEMORY_KINDS,
  type CreateMemoryInput,
  type ListMemoriesInput,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
  type MemoryTarget,
  type SearchMemoriesInput,
  type UpdateMemoryInput,
} from "./types.js";

function objectValue(value: unknown, message = "request body must be an object"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryValidationError(message);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new MemoryValidationError(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

function memoryKind(value: unknown): MemoryKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MEMORY_KINDS.includes(value as MemoryKind)) {
    throw new MemoryValidationError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  }
  return value as MemoryKind;
}

function memoryScope(value: unknown): MemoryScope | undefined {
  if (value === undefined) return undefined;
  if (value !== "personal" && value !== "project") {
    throw new MemoryValidationError("scope must be personal or project");
  }
  return value;
}

function memoryStatus(value: unknown): MemoryStatus | undefined {
  if (value === undefined) return undefined;
  if (value !== "active" && value !== "archived") {
    throw new MemoryValidationError("status must be active or archived");
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new MemoryValidationError(`${field} must be a number`);
  return number;
}

function metadataValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : objectValue(value, "metadata must be an object");
}

export function parseCreateMemoryBody(value: unknown): CreateMemoryInput {
  const body = objectValue(value);
  const sourceValue = body.source === undefined ? undefined : objectValue(body.source, "source must be an object");
  let entryIds: readonly string[] | undefined;
  if (sourceValue?.entryIds !== undefined) {
    if (!Array.isArray(sourceValue.entryIds) || sourceValue.entryIds.some((item) => typeof item !== "string")) {
      throw new MemoryValidationError("source.entryIds must be a string array");
    }
    entryIds = sourceValue.entryIds;
  }

  const source = sourceValue === undefined
    ? undefined
    : {
        ...(optionalString(sourceValue.sessionId, "source.sessionId") === undefined
          ? {}
          : { sessionId: optionalString(sourceValue.sessionId, "source.sessionId") }),
        ...(entryIds === undefined ? {} : { entryIds }),
        ...(optionalString(sourceValue.workflowInvocationId, "source.workflowInvocationId") === undefined
          ? {}
          : { workflowInvocationId: optionalString(sourceValue.workflowInvocationId, "source.workflowInvocationId") }),
      };

  return {
    text: stringValue(body.text, "text"),
    ...(memoryKind(body.kind) === undefined ? {} : { kind: memoryKind(body.kind) }),
    ...(memoryScope(body.scope) === undefined ? {} : { scope: memoryScope(body.scope) }),
    ...(optionalString(body.projectId, "projectId") === undefined
      ? {}
      : { projectId: optionalString(body.projectId, "projectId") }),
    ...(metadataValue(body.metadata) === undefined ? {} : { metadata: metadataValue(body.metadata) }),
    ...(source === undefined ? {} : { source }),
  } as CreateMemoryInput;
}

export function parseUpdateMemoryBody(value: unknown): UpdateMemoryInput {
  const body = objectValue(value);
  let projectId: string | null | undefined;
  if (body.projectId === null) projectId = null;
  else projectId = optionalString(body.projectId, "projectId");

  return {
    ...(optionalString(body.text, "text") === undefined ? {} : { text: optionalString(body.text, "text") }),
    ...(memoryKind(body.kind) === undefined ? {} : { kind: memoryKind(body.kind) }),
    ...(memoryScope(body.scope) === undefined ? {} : { scope: memoryScope(body.scope) }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(metadataValue(body.metadata) === undefined ? {} : { metadata: metadataValue(body.metadata) }),
    ...(memoryStatus(body.status) === undefined ? {} : { status: memoryStatus(body.status) }),
  } as UpdateMemoryInput;
}

export function parseSearchMemoryBody(value: unknown): SearchMemoriesInput {
  const body = objectValue(value);
  return {
    query: stringValue(body.query, "query"),
    ...(memoryScope(body.scope) === undefined ? {} : { scope: memoryScope(body.scope) }),
    ...(optionalString(body.projectId, "projectId") === undefined
      ? {}
      : { projectId: optionalString(body.projectId, "projectId") }),
    ...(memoryKind(body.kind) === undefined ? {} : { kind: memoryKind(body.kind) }),
    ...(finiteNumber(body.topK, "topK") === undefined ? {} : { topK: finiteNumber(body.topK, "topK") }),
    ...(finiteNumber(body.threshold, "threshold") === undefined
      ? {}
      : { threshold: finiteNumber(body.threshold, "threshold") }),
  } as SearchMemoriesInput;
}

function queryScalar(value: unknown): string | undefined {
  if (Array.isArray(value)) return queryScalar(value[0]);
  return typeof value === "string" ? value : undefined;
}

export function parseMemoryTargetValue(value: unknown): MemoryTarget {
  const target = objectValue(value, "target must be an object");
  if (target.type === "personal") return { type: "personal" };
  if (target.type === "project") {
    const projectId = stringValue(target.projectId, "target.projectId").trim();
    if (projectId === "") throw new MemoryValidationError("target.projectId cannot be empty");
    return { type: "project", projectId };
  }
  throw new MemoryValidationError("target.type must be personal or project");
}

export function parseMemoryTargetsBody(body: Record<string, unknown>): readonly MemoryTarget[] {
  if (body.targets !== undefined) {
    if (!Array.isArray(body.targets)) throw new MemoryValidationError("targets must be an array");
    return body.targets.map(parseMemoryTargetValue);
  }
  if (body.target !== undefined) return [parseMemoryTargetValue(body.target)];
  const scope = memoryScope(body.scope);
  if (scope === "project") {
    const projectId = optionalString(body.projectId, "projectId")?.trim();
    if (!projectId) throw new MemoryValidationError("project target requires projectId");
    return [{ type: "project", projectId }];
  }
  return [{ type: "personal" }];
}

export function parseMemoryTargetQuery(query: Record<string, unknown>): MemoryTarget {
  const scope = queryScalar(query.scope);
  const projectId = queryScalar(query.projectId);
  if (scope === "project") {
    if (projectId === undefined || projectId.trim() === "") {
      throw new MemoryValidationError("project target requires projectId");
    }
    return { type: "project", projectId: projectId.trim() };
  }
  if (scope !== undefined && scope !== "personal") {
    throw new MemoryValidationError("scope must be personal or project");
  }
  return { type: "personal" };
}

export function parseListMemoryQuery(query: Record<string, unknown>): ListMemoriesInput {
  const scope = queryScalar(query.scope);
  const projectId = queryScalar(query.projectId);
  const kind = queryScalar(query.kind);
  const status = queryScalar(query.status);
  const limit = queryScalar(query.limit);
  const offset = queryScalar(query.offset);
  return {
    ...(memoryScope(scope) === undefined ? {} : { scope: memoryScope(scope) }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(memoryKind(kind) === undefined ? {} : { kind: memoryKind(kind) }),
    ...(memoryStatus(status) === undefined ? {} : { status: memoryStatus(status) }),
    ...(limit === undefined ? {} : { limit: finiteNumber(limit, "limit") }),
    ...(offset === undefined ? {} : { offset: finiteNumber(offset, "offset") }),
  } as ListMemoriesInput;
}

export function memoryHttpError(error: unknown): never {
  if (error instanceof MemoryValidationError) {
    throw createError({ statusCode: 400, statusMessage: error.message });
  }
  if (error instanceof MemoryNotFoundError) {
    throw createError({ statusCode: 404, statusMessage: error.message });
  }
  if (error instanceof MemoryIndexError) {
    throw createError({
      statusCode: 503,
      statusMessage: error.message,
      data: { memoryId: error.memoryId, persistedInChat: true },
    });
  }
  throw error;
}

import { readFileSync } from "node:fs";
import type { OutboxEntryId } from "@chat/contracts";
import {
  assertRuntimeBindingsIntegrity,
  runtimeBindingsFileSchema,
  type RuntimeBindingsFile,
} from "./runtime-bindings-schema.js";

export interface SafeMemoryImportRuntimeEvidence {
  readonly status: "ok" | "missing" | "invalid" | "mismatch";
  readonly entries: readonly {
    readonly outboxId: string;
    readonly mode: "import" | "reconcile";
    readonly state: "started" | "outcome_unknown" | "missing";
    readonly workflowDefinitionVersion: string | null;
  }[];
}

/** 严格解析包含私有身份的Binding文件，只返回不含Workflow Run ID/Token的安全投影。 */
export function readSafeMemoryImportRuntimeEvidence(input: {
  readonly path: string | undefined;
  readonly memoryImportIntentId: string;
  readonly memoryImportResultId: string;
  readonly outbox: readonly {
    readonly outboxId: string;
    readonly kind: "memory_import_start" | "memory_import_reconcile";
  }[];
}): SafeMemoryImportRuntimeEvidence {
  if (input.path === undefined) return { status: "missing", entries: [] };
  let parsed: RuntimeBindingsFile;
  try {
    parsed = runtimeBindingsFileSchema.parse(JSON.parse(readFileSync(input.path, "utf8")));
    assertRuntimeBindingsIntegrity(parsed);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return { status: "missing", entries: [] };
    }
    return { status: "invalid", entries: [] };
  }
  let mismatch = false;
  const entries: SafeMemoryImportRuntimeEvidence["entries"] = input.outbox.map((entry) => {
    const expectedMode = entry.kind === "memory_import_start" ? "import" : "reconcile";
    const workflow = parsed.memoryImportWorkflows[entry.outboxId as OutboxEntryId];
    const start = parsed.memoryImportStartIntents[entry.outboxId as OutboxEntryId];
    const candidate = workflow ?? start;
    const state =
      workflow !== undefined
        ? "started"
        : start?.state === "outcome_unknown"
          ? "outcome_unknown"
          : "missing";
    const version = candidate?.workflowDefinitionVersion ?? null;
    if (
      candidate?.memoryImportIntentId !== input.memoryImportIntentId ||
      candidate.memoryImportResultId !== input.memoryImportResultId ||
      candidate.mode !== expectedMode ||
      version === null ||
      state === "missing"
    ) {
      mismatch = true;
    }
    return {
      outboxId: entry.outboxId,
      mode: expectedMode,
      state,
      workflowDefinitionVersion: version,
    };
  });
  return { status: mismatch ? "mismatch" : "ok", entries };
}

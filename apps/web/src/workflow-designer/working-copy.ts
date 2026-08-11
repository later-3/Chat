import {
  saveWorkflowDefinitionDraftPayloadSchema,
  workflowDesignerOperationSchema,
} from "@chat/contracts/public";
import { z } from "zod";
import {
  applyDesignerOperation,
  designerSemanticSignature,
  type DesignerOperation,
  type DesignerOperationContext,
  type DesignerOperationErrorCode,
} from "./structure-operations.js";
import type { EditableWorkflowDefinitionDetail, WorkflowDefinitionSequence } from "./types.js";

export type { EditableWorkflowDefinitionDetail } from "./types.js";

interface DesignerHistorySnapshot {
  readonly semanticRoot: WorkflowDefinitionSequence;
  readonly operations: readonly DesignerOperation[];
}

export interface DesignerHistory {
  readonly workflowDefinitionId: string;
  readonly baseRevisionId: string;
  readonly baseDefinitionSha256: string;
  readonly baseSemanticRoot: WorkflowDefinitionSequence;
  readonly present: WorkflowDefinitionSequence;
  readonly operations: readonly DesignerOperation[];
  readonly past: readonly DesignerHistorySnapshot[];
  readonly future: readonly DesignerHistorySnapshot[];
}

const persistedWorkingCopySchema = z
  .object({
    version: z.literal(2),
    workflowDefinitionId: z.string().min(1).max(128),
    baseRevisionId: z.string().min(1).max(128),
    baseDefinitionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    semanticRoot: saveWorkflowDefinitionDraftPayloadSchema.shape.semanticRoot,
    operations: z.array(workflowDesignerOperationSchema).max(512),
  })
  .strict();

export const designerWorkingCopyKey = (workflowDefinitionId: string, baseHash: string) =>
  `chat.workflow-designer.v2:${workflowDefinitionId}:${baseHash}`;

export function createDesignerHistory(
  detail: EditableWorkflowDefinitionDetail,
  restored?: {
    readonly semanticRoot: WorkflowDefinitionSequence;
    readonly operations: readonly DesignerOperation[];
  },
): DesignerHistory {
  return {
    workflowDefinitionId: detail.workflowDefinitionId,
    baseRevisionId: detail.baseRevisionId,
    baseDefinitionSha256: detail.baseDefinitionSha256,
    baseSemanticRoot: detail.semanticRoot,
    present: restored?.semanticRoot ?? detail.semanticRoot,
    operations: restored?.operations ?? [],
    past: [],
    future: [],
  };
}

export function applyHistoryOperation(
  history: DesignerHistory,
  operation: DesignerOperation,
  context: DesignerOperationContext,
):
  | { readonly ok: true; readonly history: DesignerHistory }
  | { readonly ok: false; readonly code: DesignerOperationErrorCode } {
  const result = applyDesignerOperation(history.present, operation, context);
  if (!result.ok) return result;
  return {
    ok: true,
    history: {
      ...history,
      past: [...history.past, { semanticRoot: history.present, operations: history.operations }],
      present: result.semanticRoot,
      operations: [...history.operations, operation],
      future: [],
    },
  };
}

export function undoDesignerHistory(history: DesignerHistory): DesignerHistory {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    ...history,
    present: previous.semanticRoot,
    operations: previous.operations,
    past: history.past.slice(0, -1),
    future: [{ semanticRoot: history.present, operations: history.operations }, ...history.future],
  };
}

export function redoDesignerHistory(history: DesignerHistory): DesignerHistory {
  const next = history.future[0];
  if (next === undefined) return history;
  return {
    ...history,
    present: next.semanticRoot,
    operations: next.operations,
    past: [...history.past, { semanticRoot: history.present, operations: history.operations }],
    future: history.future.slice(1),
  };
}

export function resetDesignerHistory(
  detail: EditableWorkflowDefinitionDetail,
  semanticRoot: WorkflowDefinitionSequence = detail.semanticRoot,
  operations: readonly DesignerOperation[] = [],
): DesignerHistory {
  return createDesignerHistory(detail, { semanticRoot, operations });
}

export function isDesignerHistoryDirty(history: DesignerHistory): boolean {
  return (
    designerSemanticSignature(history.present) !==
    designerSemanticSignature(history.baseSemanticRoot)
  );
}

export function readDesignerWorkingCopy(
  storage: Pick<Storage, "getItem">,
  detail: EditableWorkflowDefinitionDetail,
): {
  readonly semanticRoot: WorkflowDefinitionSequence;
  readonly operations: readonly DesignerOperation[];
} | null {
  const raw = storage.getItem(
    designerWorkingCopyKey(detail.workflowDefinitionId, detail.baseDefinitionSha256),
  );
  if (raw === null) return null;
  try {
    const parsed = persistedWorkingCopySchema.parse(JSON.parse(raw));
    if (
      parsed.workflowDefinitionId !== detail.workflowDefinitionId ||
      parsed.baseRevisionId !== detail.baseRevisionId ||
      parsed.baseDefinitionSha256 !== detail.baseDefinitionSha256
    ) {
      return null;
    }
    return { semanticRoot: parsed.semanticRoot, operations: parsed.operations };
  } catch {
    return null;
  }
}

export function writeDesignerWorkingCopy(
  storage: Pick<Storage, "setItem">,
  history: DesignerHistory,
): void {
  storage.setItem(
    designerWorkingCopyKey(history.workflowDefinitionId, history.baseDefinitionSha256),
    JSON.stringify({
      version: 2,
      workflowDefinitionId: history.workflowDefinitionId,
      baseRevisionId: history.baseRevisionId,
      baseDefinitionSha256: history.baseDefinitionSha256,
      semanticRoot: history.present,
      operations: history.operations,
    }),
  );
}

export function clearDesignerWorkingCopy(
  storage: Pick<Storage, "removeItem">,
  history: Pick<DesignerHistory, "workflowDefinitionId" | "baseDefinitionSha256">,
): void {
  storage.removeItem(
    designerWorkingCopyKey(history.workflowDefinitionId, history.baseDefinitionSha256),
  );
}

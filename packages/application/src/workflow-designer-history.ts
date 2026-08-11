import type { WorkflowDiagnostic, WorkflowSequence } from "@chat/domain";
import type { NodeCatalog } from "./workflow-node-catalog.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import {
  applyWorkflowStructureOperation,
  validateDesignerRoot,
  type WorkflowDesignerPolicy,
  type WorkflowStructureOperation,
} from "./workflow-structure-operations.js";

export interface WorkflowDesignerVersion {
  readonly semanticRoot: WorkflowSequence;
  readonly definitionSha256: string;
}

interface WorkflowDesignerHistoryEntry {
  readonly operation: WorkflowStructureOperation;
  readonly before: WorkflowDesignerVersion;
  readonly after: WorkflowDesignerVersion;
}

/**
 * History只拥有尚未保存的语义操作。视口、选中、缩放和折叠状态不在此结构中，
 * 因而不会造成dirty，也不会进入Definition Hash。
 */
export interface WorkflowDesignerHistory {
  readonly base: WorkflowDesignerVersion;
  readonly current: WorkflowDesignerVersion;
  readonly past: readonly WorkflowDesignerHistoryEntry[];
  readonly future: readonly WorkflowDesignerHistoryEntry[];
}

export type WorkflowDesignerHistoryResult =
  | { readonly success: true; readonly history: WorkflowDesignerHistory }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

export function initializeWorkflowDesignerHistory(
  semanticRoot: WorkflowSequence,
  policy: WorkflowDesignerPolicy,
  catalog: NodeCatalog = DEFAULT_NODE_CATALOG,
): WorkflowDesignerHistoryResult {
  const validated = validateDesignerRoot(semanticRoot, policy.blueprint, catalog);
  if (!validated.success) return validated;
  const initialVersion = makeVersion(validated.semanticRoot, validated.definitionSha256);
  return {
    success: true,
    history: { base: initialVersion, current: initialVersion, past: [], future: [] },
  };
}

export function applyWorkflowDesignerOperation(
  history: WorkflowDesignerHistory,
  operation: WorkflowStructureOperation,
  policy: WorkflowDesignerPolicy,
  catalog: NodeCatalog = DEFAULT_NODE_CATALOG,
): WorkflowDesignerHistoryResult {
  const applied = applyWorkflowStructureOperation(
    history.current.semanticRoot,
    operation,
    policy,
    catalog,
  );
  if (!applied.success) return applied;
  const after = makeVersion(applied.semanticRoot, applied.definitionSha256);
  const entry: WorkflowDesignerHistoryEntry = {
    operation: structuredClone(operation),
    before: history.current,
    after,
  };
  return {
    success: true,
    history: {
      ...history,
      current: after,
      past: [...history.past, entry],
      // 在undo后产生新操作会形成新分支，旧redo链必须丢弃。
      future: [],
    },
  };
}

export function undoWorkflowDesignerOperation(
  history: WorkflowDesignerHistory,
): WorkflowDesignerHistory {
  const entry = history.past.at(-1);
  if (entry === undefined) return history;
  return {
    ...history,
    current: entry.before,
    past: history.past.slice(0, -1),
    future: [entry, ...history.future],
  };
}

export function redoWorkflowDesignerOperation(
  history: WorkflowDesignerHistory,
): WorkflowDesignerHistory {
  const entry = history.future[0];
  if (entry === undefined) return history;
  // redo使用已验证的不可变after快照，不重新解释可能已升级的Catalog；Catalog升级走rebase。
  return {
    ...history,
    current: entry.after,
    past: [...history.past, entry],
    future: history.future.slice(1),
  };
}

export function workflowDesignerIsDirty(history: WorkflowDesignerHistory): boolean {
  return history.current.definitionSha256 !== history.base.definitionSha256;
}

export type WorkflowOperationReapplyResult =
  | {
      readonly success: true;
      readonly version: WorkflowDesignerVersion;
      readonly appliedOperations: readonly WorkflowStructureOperation[];
    }
  | {
      readonly success: false;
      readonly reason: "invalid_base";
      readonly diagnostics: readonly WorkflowDiagnostic[];
      readonly appliedOperations: readonly [];
    }
  | {
      readonly success: false;
      readonly reason: "operation_rejected";
      /** 最后一个合法结果供“另存副本”或逐项修复；绝不自动覆盖Server。 */
      readonly lastValidVersion: WorkflowDesignerVersion;
      readonly appliedOperations: readonly WorkflowStructureOperation[];
      readonly operationIndex: number;
      readonly operation: WorkflowStructureOperation;
      readonly diagnostics: readonly WorkflowDiagnostic[];
    };

/**
 * CAS冲突只重放语义operation log，不做JSON文本merge。第一个失效操作即停止，
 * 其后的操作不会被猜测性应用，用户草稿仍可由调用方完整保留。
 */
export function reapplyWorkflowOperations(
  newBase: WorkflowSequence,
  operations: readonly WorkflowStructureOperation[],
  policyFor: (root: WorkflowSequence) => WorkflowDesignerPolicy,
  catalog: NodeCatalog = DEFAULT_NODE_CATALOG,
): WorkflowOperationReapplyResult {
  const initialPolicy = policyFor(newBase);
  const initial = validateDesignerRoot(newBase, initialPolicy.blueprint, catalog);
  if (!initial.success) {
    return {
      success: false,
      reason: "invalid_base",
      diagnostics: initial.diagnostics,
      appliedOperations: [],
    };
  }
  let current = makeVersion(initial.semanticRoot, initial.definitionSha256);
  const appliedOperations: WorkflowStructureOperation[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation === undefined) break;
    const result = applyWorkflowStructureOperation(
      current.semanticRoot,
      operation,
      policyFor(current.semanticRoot),
      catalog,
    );
    if (!result.success) {
      return {
        success: false,
        reason: "operation_rejected",
        lastValidVersion: current,
        appliedOperations,
        operationIndex: index,
        operation,
        diagnostics: result.diagnostics,
      };
    }
    current = makeVersion(result.semanticRoot, result.definitionSha256);
    appliedOperations.push(structuredClone(operation));
  }
  return { success: true, version: current, appliedOperations };
}

export function workflowDesignerOperationLog(
  history: WorkflowDesignerHistory,
): readonly WorkflowStructureOperation[] {
  return history.past.map((entry) => structuredClone(entry.operation));
}

function makeVersion(
  semanticRoot: WorkflowSequence,
  definitionSha256: string,
): WorkflowDesignerVersion {
  return {
    semanticRoot: structuredClone(semanticRoot),
    definitionSha256,
  };
}

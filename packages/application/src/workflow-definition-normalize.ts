import {
  hashCanonical,
  sortWorkflowDiagnostics,
  type WorkflowDiagnostic,
  type WorkflowElement,
  type WorkflowSequence,
} from "@chat/domain";
import type { NodeCatalog } from "./workflow-node-catalog.js";

export interface NormalizedWorkflowDefinition {
  readonly semanticRoot: WorkflowSequence;
  readonly definitionSha256: string;
}

export type NormalizeWorkflowDefinitionResult =
  | { readonly success: true; readonly normalized: NormalizedWorkflowDefinition }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

interface Frame {
  readonly element: WorkflowElement;
  readonly path: string;
  readonly visited: boolean;
}

/**
 * 规范化保留Sequence顺序；Choice分支/outcome集合排序；Node parser展开默认值。
 * 显式后序栈避免递归Definition拖垮调用栈。View坐标、时间和运行资源从未进入输入。
 */
export function normalizeWorkflowDefinition(
  root: WorkflowSequence,
  catalog: NodeCatalog,
): NormalizeWorkflowDefinitionResult {
  const diagnostics: WorkflowDiagnostic[] = [];
  const normalized = new Map<WorkflowElement, WorkflowElement>();
  const stack: Frame[] = [{ element: root, path: "$", visited: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const element = frame.element;
    if (!frame.visited) {
      stack.push({ ...frame, visited: true });
      if (element.kind === "sequence") {
        for (let index = element.elements.length - 1; index >= 0; index -= 1) {
          const child = element.elements[index];
          if (child !== undefined) {
            stack.push({
              element: child,
              path: `${frame.path}.elements[${String(index)}]`,
              visited: false,
            });
          }
        }
      } else if (element.kind === "choice") {
        for (let index = element.branches.length - 1; index >= 0; index -= 1) {
          const branch = element.branches[index];
          if (branch !== undefined) {
            stack.push({
              element: branch.body,
              path: `${frame.path}.branches[${String(index)}].body`,
              visited: false,
            });
          }
        }
      } else if (element.kind === "bounded_loop") {
        stack.push({ element: element.body, path: `${frame.path}.body`, visited: false });
      }
      continue;
    }

    if (element.kind === "sequence") {
      normalized.set(element, {
        kind: "sequence",
        elements: element.elements.map((child) => requiredNormalized(normalized, child)),
      });
      continue;
    }
    if (element.kind === "choice") {
      normalized.set(element, {
        kind: "choice",
        fromDefinitionNodeId: element.fromDefinitionNodeId,
        branches: element.branches
          .map((branch) => ({
            outcome: branch.outcome,
            body: requiredSequence(normalized, branch.body),
          }))
          .sort((left, right) => left.outcome.localeCompare(right.outcome)),
      });
      continue;
    }
    if (element.kind === "bounded_loop") {
      normalized.set(element, {
        kind: "bounded_loop",
        body: requiredSequence(normalized, element.body),
        outcomeFromDefinitionNodeId: element.outcomeFromDefinitionNodeId,
        continueOutcomes: [...new Set(element.continueOutcomes)].sort(),
        exitOutcomes: [...new Set(element.exitOutcomes)].sort(),
        maxIterations: element.maxIterations,
        exceededPolicy: element.exceededPolicy,
      });
      continue;
    }

    const descriptor = catalog.get(element.nodeType, element.schemaVersion);
    if (descriptor === undefined) {
      diagnostics.push({
        family: "definition_invalid",
        code: "catalog.node_type_not_registered",
        path: frame.path,
        params: { nodeType: element.nodeType, schemaVersion: element.schemaVersion },
      });
      normalized.set(element, element);
      continue;
    }
    const expectedKind = descriptor.executorKind === "composite" ? "composite" : "task";
    if (element.kind !== expectedKind) {
      diagnostics.push({
        family: "definition_invalid",
        code: "catalog.element_executor_kind_mismatch",
        path: frame.path,
        params: { nodeType: element.nodeType, expectedKind },
      });
    }
    const parsed = catalog.parseConfig(element.nodeType, element.schemaVersion, element.config);
    if (!parsed.success) {
      for (const issue of parsed.issues) {
        diagnostics.push({
          family: "definition_invalid",
          code: issue.code,
          path: `${frame.path}.config${issue.path === "$" ? "" : issue.path.slice(1)}`,
          params: { nodeType: element.nodeType },
        });
      }
      normalized.set(element, element);
      continue;
    }
    const activation = element.defaultActivation ?? "enabled";
    if (activation === "skipped" && descriptor.skipPolicy.kind === "never") {
      diagnostics.push({
        family: "policy_denied",
        code: "policy.node_cannot_default_skip",
        path: frame.path,
        params: { nodeType: element.nodeType },
      });
    }
    normalized.set(element, {
      kind: element.kind,
      definitionNodeId: element.definitionNodeId,
      nodeType: element.nodeType,
      schemaVersion: element.schemaVersion,
      config: parsed.data,
      defaultActivation: activation,
    });
  }

  if (diagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(diagnostics) };
  }
  const normalizedRoot = requiredSequence(normalized, root);
  return {
    success: true,
    normalized: {
      semanticRoot: normalizedRoot,
      definitionSha256: hashCanonical("workflow-definition.v1", normalizedRoot),
    },
  };
}

function requiredNormalized(
  normalized: ReadonlyMap<WorkflowElement, WorkflowElement>,
  source: WorkflowElement,
): WorkflowElement {
  const result = normalized.get(source);
  if (result === undefined) throw new Error("workflow.normalize.missing_child");
  return result;
}

function requiredSequence(
  normalized: ReadonlyMap<WorkflowElement, WorkflowElement>,
  source: WorkflowSequence,
): WorkflowSequence {
  const result = requiredNormalized(normalized, source);
  if (result.kind !== "sequence") throw new Error("workflow.normalize.expected_sequence");
  return result;
}

import { nodeExecutorKey, type WorkflowExecutorManifestEntry } from "@chat/application";
import {
  WORKFLOW_NODE_TYPES,
  type WorkflowExecutorKind,
  type WorkflowNodeTypeKey,
} from "@chat/domain";

export const DEFINITION_KERNEL_RUNNER_FAMILY = "definition-kernel-lab.v1" as const;
export const DEFINITION_KERNEL_RUNNER_BUNDLE_VERSION = "definition-kernel-lab.bundle.v1" as const;

export interface KernelExecutorRegistration extends WorkflowExecutorManifestEntry {
  readonly executorKind: WorkflowExecutorKind;
  /** 明确的Application/Runtime业务边界；不能是任意HTTP method或用户代码。 */
  readonly operation:
    | "load_memory_context"
    | "load_project_context"
    | "resolve_rules"
    | "resolve_skills"
    | "research"
    | "plan"
    | "review_plan"
    | "execute_plan"
    | "validate_result"
    | "commit_product"
    | "extract_note"
    | "classify_note"
    | "review_note"
    | "commit_note";
}

const REGISTRATIONS: readonly KernelExecutorRegistration[] = [
  entry("context.memory", "step", "load_memory_context"),
  entry("context.project", "step", "load_project_context"),
  entry("policy.rules", "step", "resolve_rules"),
  entry("capability.skills", "step", "resolve_skills"),
  entry("agent.research", "step", "research"),
  entry("agent.plan", "step", "plan"),
  entry("human.plan_review", "human_review", "review_plan"),
  entry("execute.plan", "composite", "execute_plan"),
  entry("result.validate", "step", "validate_result"),
  entry("product.commit", "step", "commit_product"),
  entry("note.extract", "step", "extract_note"),
  entry("note.classify", "step", "classify_note"),
  entry("human.note_review", "human_review", "review_note"),
  entry("note.commit", "step", "commit_note"),
] satisfies readonly KernelExecutorRegistration[];

export class KernelExecutorRegistry {
  readonly #byKey: ReadonlyMap<string, KernelExecutorRegistration>;

  constructor(entries: readonly KernelExecutorRegistration[]) {
    const byKey = new Map<string, KernelExecutorRegistration>();
    for (const registration of entries) {
      const key = nodeExecutorKey(registration.nodeType, registration.schemaVersion);
      if (byKey.has(key)) throw new Error(`workflow.executor_registry.duplicate_key:${key}`);
      byKey.set(key, registration);
    }
    this.#byKey = byKey;
  }

  get(
    nodeType: WorkflowNodeTypeKey,
    schemaVersion: number,
  ): KernelExecutorRegistration | undefined {
    return this.#byKey.get(nodeExecutorKey(nodeType, schemaVersion));
  }

  list(): readonly KernelExecutorRegistration[] {
    return [...this.#byKey.values()].sort((left, right) =>
      nodeExecutorKey(left.nodeType, left.schemaVersion).localeCompare(
        nodeExecutorKey(right.nodeType, right.schemaVersion),
      ),
    );
  }

  manifest(): readonly WorkflowExecutorManifestEntry[] {
    return this.list().map(({ nodeType, schemaVersion, executorVersion }) => ({
      nodeType,
      schemaVersion,
      executorVersion,
    }));
  }
}

export const DEFINITION_KERNEL_EXECUTORS = new KernelExecutorRegistry(REGISTRATIONS);

if (DEFINITION_KERNEL_EXECUTORS.list().length !== WORKFLOW_NODE_TYPES.length) {
  throw new Error("workflow.executor_registry.incomplete_builtin_set");
}

function entry(
  nodeType: WorkflowNodeTypeKey,
  executorKind: WorkflowExecutorKind,
  operation: KernelExecutorRegistration["operation"],
): KernelExecutorRegistration {
  return {
    nodeType,
    schemaVersion: 1,
    executorVersion: `${nodeType}.v1`,
    executorKind,
    operation,
  };
}

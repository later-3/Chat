import type { WorkflowExecutorManifestEntry } from "@chat/contracts";

type WorkflowNodeTypeKey = WorkflowExecutorManifestEntry["nodeType"];
type WorkflowExecutorKind = "step" | "human_review" | "composite";

export const DEFINITION_KERNEL_RUNNER_FAMILY = "definition-kernel-lab.v1" as const;
export const DEFINITION_KERNEL_RUNNER_BUNDLE_VERSION = "definition-kernel-lab.bundle.v1" as const;

/**
 * S4正式Planning Runner与S3实验室使用不同的耐久身份。
 *
 * 这两个值会同时进入Product Run/RunSpec与Runtime Binding；发布回滚只能停止创建
 * 这个family的新Run，不能把已经创建的Run改标给legacy bundle继续执行。
 */
export const CONFIGURABLE_PLANNING_RUNNER_FAMILY = "configurable-planning.v1" as const;
export const LEGACY_CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION =
  "configurable-planning.bundle.v1" as const;
export const CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION =
  "configurable-planning.bundle.v2" as const;
export const LEGACY_PLANNING_RUNNER_FAMILY = "legacy-planning.v1" as const;
export const LEGACY_PLANNING_RUNNER_BUNDLE_VERSION = "legacy-planning.bundle.v1" as const;
export const NOTE_CAPTURE_RUNNER_FAMILY = "note-capture.v1" as const;
export const NOTE_CAPTURE_RUNNER_BUNDLE_VERSION = "note-capture.bundle.v1" as const;
export const DIRECT_AGENT_RUNNER_FAMILY = "direct-agent.v1" as const;
export const DIRECT_AGENT_RUNNER_BUNDLE_VERSION = "direct-agent.bundle.v1" as const;

export type PlanningRunnerFamily =
  typeof LEGACY_PLANNING_RUNNER_FAMILY | typeof CONFIGURABLE_PLANNING_RUNNER_FAMILY;
export type ProductWorkflowRunnerFamily =
  PlanningRunnerFamily | typeof NOTE_CAPTURE_RUNNER_FAMILY | typeof DIRECT_AGENT_RUNNER_FAMILY;

export interface KernelExecutorRegistration extends WorkflowExecutorManifestEntry {
  readonly executorKind: WorkflowExecutorKind;
  /** 明确的Application/Runtime业务边界；不能是任意HTTP method或用户代码。 */
  readonly operation:
    | "query_memory"
    | "write_memory"
    | "load_memory_context"
    | "load_project_context"
    | "resolve_rules"
    | "resolve_skills"
    | "research"
    | "plan"
    | "review_plan"
    | "execute_plan"
    | "review_governance"
    | "validate_result"
    | "commit_product"
    | "extract_note"
    | "classify_note"
    | "review_note"
    | "commit_note"
    | "advance_direct_agent"
    | "review_prompt";
}

const REGISTRATIONS: readonly KernelExecutorRegistration[] = [
  entry("memory.query", "step", "query_memory"),
  entry("memory.write", "step", "write_memory"),
  entry("context.memory", "step", "load_memory_context"),
  entry("context.project", "step", "load_project_context"),
  entry("policy.rules", "step", "resolve_rules"),
  entry("capability.skills", "step", "resolve_skills"),
  entry("agent.research", "step", "research"),
  entry("agent.plan", "step", "plan"),
  entry("human.plan_review", "human_review", "review_plan"),
  entry("execute.plan", "composite", "execute_plan"),
  entry("agent.governance_check", "step", "review_governance"),
  entry("result.validate", "step", "validate_result"),
  entry("product.commit", "step", "commit_product"),
  entry("note.extract", "step", "extract_note"),
  entry("note.classify", "step", "classify_note"),
  entry("human.note_review", "human_review", "review_note"),
  entry("note.commit", "step", "commit_note"),
  entry("agent.direct", "composite", "advance_direct_agent"),
  entry("human.prompt_review", "human_review", "review_prompt"),
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

// 静态表同时被Workflow函数解释器引用，不能为一个key helper拉入Application或
// Domain运行时代码（其中含Node crypto，Workflow sandbox不允许）。19是冻结内置集合，
// Catalog/Compiler的完整集合一致性另由definition-kernel conformance测试逐项证明。
if (DEFINITION_KERNEL_EXECUTORS.list().length !== 19) {
  throw new Error("workflow.executor_registry.incomplete_builtin_set");
}

function nodeExecutorKey(nodeType: WorkflowNodeTypeKey, schemaVersion: number): string {
  return `${nodeType}@${String(schemaVersion)}`;
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

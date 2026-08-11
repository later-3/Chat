import type { WorkflowExecutorManifestEntry } from "@chat/contracts";
import { NODE_CATALOG_DESCRIPTORS } from "./workflow-node-catalog.js";

/**
 * 编译正式RunSpec时冻结的内置Executor版本证据。它属于部署合同，不属于测试Fixture；
 * Workflow包用conformance测试证明静态Registry与这里逐项一致。
 */
export const BUILTIN_WORKFLOW_EXECUTOR_MANIFEST: readonly WorkflowExecutorManifestEntry[] =
  NODE_CATALOG_DESCRIPTORS.map((descriptor) => ({
    nodeType: descriptor.nodeType,
    schemaVersion: descriptor.schemaVersion,
    executorVersion: `${descriptor.nodeType}.v1`,
  }));

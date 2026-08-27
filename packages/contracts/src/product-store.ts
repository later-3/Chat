import { z } from "zod";
import {
  approvalRequestSchema,
  artifactSchema,
  commandReceiptSchema,
  decisionSchema,
  executionCandidateSchema,
  executionContractSchema,
  messageSchema,
  outboxEntrySchema,
  planRevisionSchema,
  productRunSchema,
  productSessionSchema,
  revisionInputSchema,
  runAttemptSchema,
  validationResultSchema,
} from "./product.js";
import {
  workflowDefinitionRevisionSchema,
  workflowDefinitionSchema,
  workflowRunSpecSchema,
} from "./workflow-definition.js";
import {
  nodeRunTransitionSchema,
  nodeValueManifestSchema,
  workflowNodeRunSchema,
  workflowViewDefinitionSchema,
} from "./workflow-run.js";
import {
  contextPackageSchema,
  memoryAdoptionSchema,
  memoryQuerySchema,
  memoryResultSnapshotSchema,
  runContextRequestSchema,
} from "./context.js";
import { memoryImportIntentSchema, memoryImportResultSchema } from "./memory-import.js";
import { memorySessionImportSchema } from "./memory-session-import.js";
import { directAgentCandidateSchema } from "./direct-agent.js";
import { promptReviewDecisionSchema, promptReviewRequestSchema } from "./prompt-review.js";
import { promptFragmentRevisionSchema, promptFragmentSchema } from "./prompt-fragment.js";
import { promptAssemblySchema } from "./prompt-assembly.js";
import { noteCandidateSchema, noteDecisionSchema, noteRevisionSchema, noteSchema } from "./note.js";
import {
  ruleDecisionSchema,
  ruleRevisionSchema,
  ruleSchema,
  ruleSelectionSchema,
  ruleTagSchema,
} from "./rules.js";
import { planningMemorySelectionSchema } from "./planning-memory-selection.js";
import { workflowPolicyResolutionSchema } from "./workflow-policy-resolution.js";
import {
  memoryWriteIntentSchema,
  memoryWriteResultSchema,
  workflowMemoryContextSchema,
  workflowMemoryQuerySchema,
  workflowMemorySnapshotSchema,
} from "./workflow-memory.js";
import {
  memoryAgentOperationSchema,
  memoryAgentWriteCandidateSchema,
  memoryAgentWriteDecisionSchema,
} from "./memory-agent.js";
import { agentVersionSchema } from "./agent-configuration.js";
import {
  toolExecutionDecisionSchema,
  toolExecutionIntentSchema,
  toolExecutionResultSchema,
} from "./tool-execution.js";
import {
  supervisedAgentAttemptV3Schema,
  supervisedAgentOutcomeObservationV3Schema,
  supervisedCarryForwardV3Schema,
  supervisedExecutionResultV3Schema,
  supervisedPlannerVerdictV3Schema,
  supervisedPlanningEpochV3Schema,
  supervisedStepCandidateV3Schema,
  supervisedStepEvidenceV3Schema,
  supervisedStepHumanDecisionV3Schema,
  supervisedStepReviewRequestV3Schema,
  supervisedStepStateV3Schema,
} from "./supervised-planning-v3.js";

/**
 * Product Snapshot顶层合同（任务书§8.3）。
 *
 * 不变量：
 * - 单文件完整快照是产品事实源；一次transact原子提交产品事实 + Command Receipt + Outbox。
 * - 不持久化可从权威对象确定性计算的重复索引；内存索引在启动/读取时构建。
 * - 启动遇到损坏JSON、未知Schema、悬空引用、Hash不一致或非法状态时失败关闭，
 *   原文件保持逐字节不变。
 */

export const PRODUCT_STORE_SCHEMA_VERSION = "chat-product-store.v27";

const idKeySchema = z.string().min(1).max(200);

const productEntitiesSchema = z
  .object({
    sessions: z.record(idKeySchema, productSessionSchema),
    messages: z.record(idKeySchema, messageSchema),
    runs: z.record(idKeySchema, productRunSchema),
    attempts: z.record(idKeySchema, runAttemptSchema),
    plans: z.record(idKeySchema, planRevisionSchema),
    revisionInputs: z.record(idKeySchema, revisionInputSchema),
    approvalRequests: z.record(idKeySchema, approvalRequestSchema),
    decisions: z.record(idKeySchema, decisionSchema),
    executionContracts: z.record(idKeySchema, executionContractSchema),
    executionCandidates: z.record(idKeySchema, executionCandidateSchema),
    validationResults: z.record(idKeySchema, validationResultSchema),
    artifacts: z.record(idKeySchema, artifactSchema),
    directAgentCandidates: z.record(idKeySchema, directAgentCandidateSchema),
    promptReviewRequests: z.record(idKeySchema, promptReviewRequestSchema),
    promptReviewDecisions: z.record(idKeySchema, promptReviewDecisionSchema),
    promptFragments: z.record(idKeySchema, promptFragmentSchema),
    promptFragmentRevisions: z.record(idKeySchema, promptFragmentRevisionSchema),
    promptAssemblies: z.record(idKeySchema, promptAssemblySchema),
    agentVersions: z.record(idKeySchema, agentVersionSchema),
    toolExecutionIntents: z.record(idKeySchema, toolExecutionIntentSchema),
    toolExecutionDecisions: z.record(idKeySchema, toolExecutionDecisionSchema),
    toolExecutionResults: z.record(idKeySchema, toolExecutionResultSchema),
    supervisedPlanningEpochs: z.record(idKeySchema, supervisedPlanningEpochV3Schema),
    supervisedCarryForwards: z.record(idKeySchema, supervisedCarryForwardV3Schema),
    supervisedStepStates: z.record(idKeySchema, supervisedStepStateV3Schema),
    supervisedAgentAttempts: z.record(idKeySchema, supervisedAgentAttemptV3Schema),
    supervisedStepEvidence: z.record(idKeySchema, supervisedStepEvidenceV3Schema),
    supervisedStepCandidates: z.record(idKeySchema, supervisedStepCandidateV3Schema),
    supervisedPlannerVerdicts: z.record(idKeySchema, supervisedPlannerVerdictV3Schema),
    supervisedStepReviewRequests: z.record(idKeySchema, supervisedStepReviewRequestV3Schema),
    supervisedStepHumanDecisions: z.record(idKeySchema, supervisedStepHumanDecisionV3Schema),
    supervisedAgentOutcomeObservations: z.record(
      idKeySchema,
      supervisedAgentOutcomeObservationV3Schema,
    ),
    supervisedExecutionResults: z.record(idKeySchema, supervisedExecutionResultV3Schema),
    contextRequests: z.record(idKeySchema, runContextRequestSchema),
    memoryQueries: z.record(idKeySchema, memoryQuerySchema),
    memoryResultSnapshots: z.record(idKeySchema, memoryResultSnapshotSchema),
    memoryAdoptions: z.record(idKeySchema, memoryAdoptionSchema),
    contextPackages: z.record(idKeySchema, contextPackageSchema),
    memoryImportIntents: z.record(idKeySchema, memoryImportIntentSchema),
    memoryImportResults: z.record(idKeySchema, memoryImportResultSchema),
    memorySessionImports: z.record(idKeySchema, memorySessionImportSchema),
    workflowViewDefinitions: z.record(idKeySchema, workflowViewDefinitionSchema),
    workflowDefinitions: z.record(idKeySchema, workflowDefinitionSchema),
    workflowDefinitionRevisions: z.record(idKeySchema, workflowDefinitionRevisionSchema),
    workflowRunSpecs: z.record(idKeySchema, workflowRunSpecSchema),
    workflowNodeRuns: z.record(idKeySchema, workflowNodeRunSchema),
    nodeRunTransitions: z.record(idKeySchema, nodeRunTransitionSchema),
    nodeValueManifests: z.record(idKeySchema, nodeValueManifestSchema),
    notes: z.record(idKeySchema, noteSchema),
    noteRevisions: z.record(idKeySchema, noteRevisionSchema),
    noteCandidates: z.record(idKeySchema, noteCandidateSchema),
    noteDecisions: z.record(idKeySchema, noteDecisionSchema),
    rules: z.record(idKeySchema, ruleSchema),
    ruleRevisions: z.record(idKeySchema, ruleRevisionSchema),
    ruleTags: z.record(idKeySchema, ruleTagSchema),
    ruleDecisions: z.record(idKeySchema, ruleDecisionSchema),
    ruleSelections: z.record(idKeySchema, ruleSelectionSchema),
    planningMemorySelections: z.record(idKeySchema, planningMemorySelectionSchema),
    workflowPolicyResolutions: z.record(idKeySchema, workflowPolicyResolutionSchema),
    workflowMemoryQueries: z.record(idKeySchema, workflowMemoryQuerySchema),
    workflowMemorySnapshots: z.record(idKeySchema, workflowMemorySnapshotSchema),
    workflowMemoryContexts: z.record(idKeySchema, workflowMemoryContextSchema),
    memoryWriteIntents: z.record(idKeySchema, memoryWriteIntentSchema),
    memoryWriteResults: z.record(idKeySchema, memoryWriteResultSchema),
    memoryAgentOperations: z.record(idKeySchema, memoryAgentOperationSchema),
    memoryAgentWriteCandidates: z.record(idKeySchema, memoryAgentWriteCandidateSchema),
    memoryAgentWriteDecisions: z.record(idKeySchema, memoryAgentWriteDecisionSchema),
  })
  .strict();

export const productSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_STORE_SCHEMA_VERSION),
    storeRevision: z.number().int().nonnegative(),
    committedAt: z.iso.datetime(),
    entities: productEntitiesSchema,
    commandReceipts: z.record(idKeySchema, commandReceiptSchema),
    outbox: z.record(idKeySchema, outboxEntrySchema),
  })
  .strict();

export type ProductSnapshot = z.infer<typeof productSnapshotSchema>;
export type ProductEntities = ProductSnapshot["entities"];

export function createEmptySnapshot(committedAt: string): ProductSnapshot {
  return {
    schemaVersion: PRODUCT_STORE_SCHEMA_VERSION,
    storeRevision: 0,
    committedAt,
    entities: {
      sessions: {},
      messages: {},
      runs: {},
      attempts: {},
      plans: {},
      revisionInputs: {},
      approvalRequests: {},
      decisions: {},
      executionContracts: {},
      executionCandidates: {},
      validationResults: {},
      artifacts: {},
      directAgentCandidates: {},
      promptReviewRequests: {},
      promptReviewDecisions: {},
      promptFragments: {},
      promptFragmentRevisions: {},
      promptAssemblies: {},
      agentVersions: {},
      toolExecutionIntents: {},
      toolExecutionDecisions: {},
      toolExecutionResults: {},
      supervisedPlanningEpochs: {},
      supervisedCarryForwards: {},
      supervisedStepStates: {},
      supervisedAgentAttempts: {},
      supervisedStepEvidence: {},
      supervisedStepCandidates: {},
      supervisedPlannerVerdicts: {},
      supervisedStepReviewRequests: {},
      supervisedStepHumanDecisions: {},
      supervisedAgentOutcomeObservations: {},
      supervisedExecutionResults: {},
      contextRequests: {},
      memoryQueries: {},
      memoryResultSnapshots: {},
      memoryAdoptions: {},
      contextPackages: {},
      memoryImportIntents: {},
      memoryImportResults: {},
      memorySessionImports: {},
      workflowViewDefinitions: {},
      workflowDefinitions: {},
      workflowDefinitionRevisions: {},
      workflowRunSpecs: {},
      workflowNodeRuns: {},
      nodeRunTransitions: {},
      nodeValueManifests: {},
      notes: {},
      noteRevisions: {},
      noteCandidates: {},
      noteDecisions: {},
      rules: {},
      ruleRevisions: {},
      ruleTags: {},
      ruleDecisions: {},
      ruleSelections: {},
      planningMemorySelections: {},
      workflowPolicyResolutions: {},
      workflowMemoryQueries: {},
      workflowMemorySnapshots: {},
      workflowMemoryContexts: {},
      memoryWriteIntents: {},
      memoryWriteResults: {},
      memoryAgentOperations: {},
      memoryAgentWriteCandidates: {},
      memoryAgentWriteDecisions: {},
    },
    commandReceipts: {},
    outbox: {},
  };
}

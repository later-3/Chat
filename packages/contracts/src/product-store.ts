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
import { directAgentCandidateSchema } from "./direct-agent.js";
import { promptReviewDecisionSchema, promptReviewRequestSchema } from "./prompt-review.js";
import {
  projectActionSchema,
  projectCandidateSchema,
  projectContributionSchema,
  projectDecisionSchema,
  projectEvidenceSchema,
  projectMethodSnapshotSchema,
  projectMilestoneSchema,
  projectObservationSchema,
  projectParticipantSchema,
  projectResourceSchema,
  projectSchema,
  projectStageSchema,
  projectStateTransitionSchema,
  projectUpdateSchema,
  projectWorkSchema,
} from "./project.js";
import { noteCandidateSchema, noteDecisionSchema, noteRevisionSchema, noteSchema } from "./note.js";
import {
  ruleDecisionSchema,
  ruleRevisionSchema,
  ruleSchema,
  ruleSelectionSchema,
  ruleTagSchema,
} from "./rules.js";
import { planningProjectContextSchema } from "./planning-project-context.js";
import { planningMemorySelectionSchema } from "./planning-memory-selection.js";
import { workflowPolicyResolutionSchema } from "./workflow-policy-resolution.js";
import {
  memoryWriteIntentSchema,
  memoryWriteResultSchema,
  workflowMemoryContextSchema,
  workflowMemoryQuerySchema,
  workflowMemorySnapshotSchema,
} from "./workflow-memory.js";

/**
 * Product Snapshot顶层合同（任务书§8.3）。
 *
 * 不变量：
 * - 单文件完整快照是产品事实源；一次transact原子提交产品事实 + Command Receipt + Outbox。
 * - 不持久化可从权威对象确定性计算的重复索引；内存索引在启动/读取时构建。
 * - 启动遇到损坏JSON、未知Schema、悬空引用、Hash不一致或非法状态时失败关闭，
 *   原文件保持逐字节不变。
 */

export const PRODUCT_STORE_SCHEMA_VERSION = "chat-product-store.v13";

const idKeySchema = z.string().min(1).max(200);

export const productSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PRODUCT_STORE_SCHEMA_VERSION),
    storeRevision: z.number().int().nonnegative(),
    committedAt: z.iso.datetime(),
    entities: z
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
        contextRequests: z.record(idKeySchema, runContextRequestSchema),
        memoryQueries: z.record(idKeySchema, memoryQuerySchema),
        memoryResultSnapshots: z.record(idKeySchema, memoryResultSnapshotSchema),
        memoryAdoptions: z.record(idKeySchema, memoryAdoptionSchema),
        contextPackages: z.record(idKeySchema, contextPackageSchema),
        memoryImportIntents: z.record(idKeySchema, memoryImportIntentSchema),
        memoryImportResults: z.record(idKeySchema, memoryImportResultSchema),
        projects: z.record(idKeySchema, projectSchema),
        projectMethodSnapshots: z.record(idKeySchema, projectMethodSnapshotSchema),
        projectStages: z.record(idKeySchema, projectStageSchema),
        projectMilestones: z.record(idKeySchema, projectMilestoneSchema),
        projectUpdates: z.record(idKeySchema, projectUpdateSchema),
        projectStateTransitions: z.record(idKeySchema, projectStateTransitionSchema),
        projectResources: z.record(idKeySchema, projectResourceSchema),
        projectParticipants: z.record(idKeySchema, projectParticipantSchema),
        projectWorks: z.record(idKeySchema, projectWorkSchema),
        projectActions: z.record(idKeySchema, projectActionSchema),
        projectContributions: z.record(idKeySchema, projectContributionSchema),
        projectEvidence: z.record(idKeySchema, projectEvidenceSchema),
        projectDecisions: z.record(idKeySchema, projectDecisionSchema),
        projectObservations: z.record(idKeySchema, projectObservationSchema),
        projectCandidates: z.record(idKeySchema, projectCandidateSchema),
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
        planningProjectContexts: z.record(idKeySchema, planningProjectContextSchema),
        planningMemorySelections: z.record(idKeySchema, planningMemorySelectionSchema),
        workflowPolicyResolutions: z.record(idKeySchema, workflowPolicyResolutionSchema),
        workflowMemoryQueries: z.record(idKeySchema, workflowMemoryQuerySchema),
        workflowMemorySnapshots: z.record(idKeySchema, workflowMemorySnapshotSchema),
        workflowMemoryContexts: z.record(idKeySchema, workflowMemoryContextSchema),
        memoryWriteIntents: z.record(idKeySchema, memoryWriteIntentSchema),
        memoryWriteResults: z.record(idKeySchema, memoryWriteResultSchema),
      })
      .strict(),
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
      contextRequests: {},
      memoryQueries: {},
      memoryResultSnapshots: {},
      memoryAdoptions: {},
      contextPackages: {},
      memoryImportIntents: {},
      memoryImportResults: {},
      projects: {},
      projectMethodSnapshots: {},
      projectStages: {},
      projectMilestones: {},
      projectUpdates: {},
      projectStateTransitions: {},
      projectResources: {},
      projectParticipants: {},
      projectWorks: {},
      projectActions: {},
      projectContributions: {},
      projectEvidence: {},
      projectDecisions: {},
      projectObservations: {},
      projectCandidates: {},
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
      planningProjectContexts: {},
      planningMemorySelections: {},
      workflowPolicyResolutions: {},
      workflowMemoryQueries: {},
      workflowMemorySnapshots: {},
      workflowMemoryContexts: {},
      memoryWriteIntents: {},
      memoryWriteResults: {},
    },
    commandReceipts: {},
    outbox: {},
  };
}

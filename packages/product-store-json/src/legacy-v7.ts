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
} from "@chat/contracts";
import {
  workflowDefinitionRevisionSchema,
  workflowDefinitionSchema,
  workflowRunSpecSchema,
  workflowViewDefinitionSchema,
  nodeRunTransitionSchema,
  nodeValueManifestSchema,
  workflowNodeRunSchema,
} from "@chat/contracts";
import {
  contextPackageSchema,
  memoryAdoptionSchema,
  memoryQuerySchema,
  memoryResultSnapshotSchema,
  runContextRequestSchema,
} from "@chat/contracts";
import { memoryImportIntentSchema, memoryImportResultSchema } from "@chat/contracts";
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
} from "@chat/contracts";

const idKeySchema = z.string().min(1).max(200);

/**
 * S4持久化快照：已有Workflow Definition/RunSpec，但尚无Note产品集合。
 * v7 reader只用于迁移，不能被新事务继续写入。
 */
export const productSnapshotV7Schema = z
  .object({
    schemaVersion: z.literal("chat-product-store.v7"),
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
      })
      .strict(),
    commandReceipts: z.record(idKeySchema, commandReceiptSchema),
    outbox: z.record(idKeySchema, outboxEntrySchema),
  })
  .strict();

export type ProductSnapshotV7 = z.infer<typeof productSnapshotV7Schema>;

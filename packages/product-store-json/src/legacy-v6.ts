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
  productRunV2Schema,
  productSessionSchema,
  revisionInputSchema,
  runAttemptSchema,
  validationResultSchema,
} from "@chat/contracts";
import {
  nodeRunTransitionSchema,
  nodeValueManifestSchema,
  workflowNodeRunSchema,
  workflowViewDefinitionSchema,
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
  projectMilestoneSchema,
  projectObservationSchema,
  projectParticipantSchema,
  projectResourceSchema,
  projectSchema,
  projectStageSchema,
  projectStateTransitionSchema,
  projectUpdateSchema,
} from "@chat/contracts";
import {
  projectDecisionV19Schema as projectDecisionSchema,
  projectEvidenceV19Schema as projectEvidenceSchema,
  projectMethodSnapshotV19Schema as projectMethodSnapshotSchema,
  projectWorkV19Schema as projectWorkSchema,
} from "./legacy-v19.js";

const idKeySchema = z.string().min(1).max(200);

/** v6完整历史快照：与当前v7相比，仅Run仍是product-run.v2，且尚无Definition/RunSpec集合。 */
export const productSnapshotV6Schema = z
  .object({
    schemaVersion: z.literal("chat-product-store.v6"),
    storeRevision: z.number().int().nonnegative(),
    committedAt: z.iso.datetime(),
    entities: z
      .object({
        sessions: z.record(idKeySchema, productSessionSchema),
        messages: z.record(idKeySchema, messageSchema),
        runs: z.record(idKeySchema, productRunV2Schema),
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
        workflowNodeRuns: z.record(idKeySchema, workflowNodeRunSchema),
        nodeRunTransitions: z.record(idKeySchema, nodeRunTransitionSchema),
        nodeValueManifests: z.record(idKeySchema, nodeValueManifestSchema),
      })
      .strict(),
    commandReceipts: z.record(idKeySchema, commandReceiptSchema),
    outbox: z.record(idKeySchema, outboxEntrySchema),
  })
  .strict();

export type ProductSnapshotV6 = z.infer<typeof productSnapshotV6Schema>;

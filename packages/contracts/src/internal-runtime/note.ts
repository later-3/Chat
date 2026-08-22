/**
 * 内部Runtime合同 note 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  commandIdSchema,
  productRunIdSchema,
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  workflowRunSpecIdSchema,
  workflowPolicyResolutionIdSchema,
} from "../ids.js";
import { sha256Schema } from "../hash.js";
import {
  NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS,
  NOTE_TAG_LABEL_MAX_CHARACTERS,
  NOTE_TAG_MAX_COUNT,
  noteKindSchema,
  noteSourceRefSchema,
} from "../note.js";
import {
  noteCandidateReviewDtoSchema,
  noteDecisionDtoSchema,
  noteRevisionInputSchema,
} from "../note-api.js";
import { workflowExecutionPathSegmentSchema } from "../workflow-run.js";
import { versioned, workflowNodePromptRuntimeSchema } from "./shared.js";

export const publishNoteCandidateRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    proposed: noteRevisionInputSchema,
  })
  .strict();

export const publishNoteCandidateRuntimeResponseSchema = z
  .object({
    ...versioned,
    candidate: noteCandidateReviewDtoSchema,
    review: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("waiting_human") }).strict(),
      z
        .object({
          outcome: z.literal("policy_denied_waiting_human"),
          policyResolutionRef: z
            .object({
              workflowPolicyResolutionId: workflowPolicyResolutionIdSchema,
              revision: z.literal(1),
              sha256: sha256Schema,
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          outcome: z.literal("auto_continued"),
          policyResolutionRef: z
            .object({
              workflowPolicyResolutionId: workflowPolicyResolutionIdSchema,
              revision: z.literal(1),
              sha256: sha256Schema,
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

export const prepareNoteCaptureInputRuntimeRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
  })
  .strict();

export const prepareNoteCaptureInputRuntimeResponseSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    source: noteSourceRefSchema,
    sourceText: z.string().min(1).max(NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS),
    defaultKind: noteKindSchema,
    suggestedTagLabels: z
      .array(z.string().trim().min(1).max(NOTE_TAG_LABEL_MAX_CHARACTERS))
      .max(NOTE_TAG_MAX_COUNT),
    nodePrompt: workflowNodePromptRuntimeSchema.optional(),
    priorCandidate: noteCandidateReviewDtoSchema.optional(),
    revisionInstruction: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const loadNoteDecisionRuntimeRequestSchema = z
  .object({
    ...versioned,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    noteCandidateId: noteCandidateIdSchema,
    noteDecisionId: noteDecisionIdSchema,
  })
  .strict();

export const loadNoteDecisionRuntimeResponseSchema = z
  .object({
    ...versioned,
    candidate: noteCandidateReviewDtoSchema,
    decision: noteDecisionDtoSchema,
  })
  .strict();

export const commitConfirmedNoteRuntimeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    noteCandidateId: noteCandidateIdSchema,
  })
  .strict();

export const commitConfirmedNoteRuntimeResponseSchema = z
  .object({
    ...versioned,
    status: z.literal("committed"),
  })
  .strict();

export const transitionConfigurablePlanningNodeRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    definitionNodeId: z.string().min(1).max(100),
    executionPath: z.array(workflowExecutionPathSegmentSchema).max(8),
    attemptNumber: z.number().int().positive().max(100),
    toStatus: z.enum([
      "running",
      "waiting_human",
      "skipped",
      "succeeded",
      "failed",
      "cancelled",
      "outcome_unknown",
    ]),
    outcomeCode: z.string().min(1).max(64).optional(),
    publicSummary: z.string().min(1).max(500).optional(),
  })
  .strict();

/* ---------- Workflow Runtime分发合同（API Outbox Dispatcher -> Workflow进程） ---------- */

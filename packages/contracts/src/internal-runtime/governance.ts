import { z } from "zod";
import {
  commandIdSchema,
  executionCandidateIdSchema,
  productRunIdSchema,
  runAttemptIdSchema,
  workflowRunSpecIdSchema,
} from "../ids.js";
import { sha256Schema } from "../hash.js";
import { executionCandidateSchema, executionContractSchema } from "../product.js";
import { governanceEvidenceKeySchema } from "../governance-review.js";
import { versioned, workflowNodePromptRuntimeSchema } from "./shared.js";

export const prepareGovernanceReviewInputRequestSchema = z
  .object({
    ...versioned,
    commandId: commandIdSchema,
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema,
    executionCandidateId: executionCandidateIdSchema,
  })
  .strict();

export const governanceReviewInputDtoSchema = z
  .object({
    attemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    productRunId: productRunIdSchema,
    contract: executionContractSchema,
    candidate: executionCandidateSchema,
    nodePrompt: workflowNodePromptRuntimeSchema,
    strictEvidence: z.boolean(),
    allowedEvidenceKeys: z.array(governanceEvidenceKeySchema).min(1).max(500),
    limits: z
      .object({
        maxTurns: z.literal(1),
        tokenBudget: z.literal(4_096),
        timeoutMs: z.number().int().positive().max(180_000),
      })
      .strict(),
  })
  .strict();

export const prepareGovernanceReviewInputResponseSchema = z
  .object({
    ...versioned,
    reviewInput: governanceReviewInputDtoSchema,
  })
  .strict();

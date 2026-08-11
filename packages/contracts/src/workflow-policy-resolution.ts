import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  noteCandidateIdSchema,
  productRunIdSchema,
  workflowPolicyResolutionIdSchema,
  workflowRunSpecIdSchema,
} from "./ids.js";
import { definitionNodeIdSchema } from "./workflow-run.js";

const policyResolutionBase = {
  schemaVersion: z.literal("workflow-policy-resolution.v1"),
  workflowPolicyResolutionId: workflowPolicyResolutionIdSchema,
  productRunId: productRunIdSchema,
  workflowRunSpecId: workflowRunSpecIdSchema,
  workflowRunSpecSha256: sha256Schema,
  definitionNodeId: definitionNodeIdSchema,
  noteCandidateId: noteCandidateIdSchema,
  candidateRevision: z.number().int().positive(),
  candidateSha256: sha256Schema,
  reviewMode: z.literal("auto_continue_if_policy_allows"),
  policyVersion: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9._-]*$/u),
  policySha256: sha256Schema,
  sha256: sha256Schema,
  revision: z.literal(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/**
 * Policy Resolution记录系统策略为何允许或拒绝自动继续。它不伪造Principal、
 * commandId或NoteDecision，且只能绑定已经持久化的候选版本与RunSpec。
 */
export const workflowPolicyResolutionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      ...policyResolutionBase,
      outcome: z.literal("allowed"),
      reasonCode: z.literal("note_candidate_within_low_risk_bounds"),
    })
    .strict(),
  z
    .object({
      ...policyResolutionBase,
      outcome: z.literal("denied"),
      reasonCode: z.literal("note_candidate_exceeds_auto_bounds"),
    })
    .strict(),
]);

export type WorkflowPolicyResolution = z.infer<typeof workflowPolicyResolutionSchema>;

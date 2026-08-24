import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { projectBootstrapCandidateIdSchema, projectBootstrapOperationIdSchema } from "./ids.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";
import {
  planeCeWorkspaceSlugSchema,
  projectBootstrapCandidateSchema,
  projectBootstrapDecisionSchema,
  projectBootstrapOperationSchema,
  projectWorkspaceBindingSchema,
} from "./project-bootstrap.js";

export const projectBootstrapConfigurationSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      providerKind: z.literal("plane_ce"),
      providerVersion: z.string().min(1).max(40),
      providerWebBaseUrl: z.url(),
      planeWorkspaceSlugs: z.array(planeCeWorkspaceSlugSchema).min(1).max(20),
      creationRoots: z
        .array(
          z
            .object({
              rootId: promptWorkspaceRootIdSchema,
              displayName: z.string().min(1).max(160),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
]);

export const projectBootstrapDecisionPayloadSchema = z
  .object({
    projectBootstrapCandidateId: projectBootstrapCandidateIdSchema,
    candidateRevision: z.number().int().positive(),
    candidateSha256: sha256Schema,
    kind: z.enum(["confirm", "reject"]),
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const projectBootstrapDecisionResponseSchema = z
  .object({
    candidate: projectBootstrapCandidateSchema,
    operation: projectBootstrapOperationSchema.optional(),
  })
  .strict();

export const retryProjectBootstrapPayloadSchema = z
  .object({
    projectBootstrapOperationId: projectBootstrapOperationIdSchema,
    expectedOperationRevision: z.number().int().positive(),
  })
  .strict();

export const projectBootstrapReviewResponseSchema = z
  .object({
    candidate: projectBootstrapCandidateSchema,
    decision: projectBootstrapDecisionSchema,
    operation: projectBootstrapOperationSchema,
    binding: projectWorkspaceBindingSchema.optional(),
  })
  .strict();

export const projectBootstrapSessionProjectionSchema = z
  .object({
    candidate: projectBootstrapCandidateSchema,
    decision: projectBootstrapDecisionSchema.optional(),
    operation: projectBootstrapOperationSchema.optional(),
    binding: projectWorkspaceBindingSchema.optional(),
    recovery: z
      .object({
        canRecover: z.boolean(),
        reason: z.enum([
          "not_applicable",
          "terminal",
          "active_execution",
          "background_dispatch_pending",
          "recovery_pending",
          "legacy_dispatch_missing",
          "retryable_failure",
        ]),
      })
      .strict(),
  })
  .strict();

export const currentProjectBootstrapResponseSchema = z
  .object({
    projectBootstrap: projectBootstrapSessionProjectionSchema.nullable(),
  })
  .strict();

export type ProjectBootstrapConfiguration = z.infer<typeof projectBootstrapConfigurationSchema>;
export type ProjectBootstrapDecisionPayload = z.infer<typeof projectBootstrapDecisionPayloadSchema>;
export type ProjectBootstrapReviewResponse = z.infer<typeof projectBootstrapReviewResponseSchema>;
export type ProjectBootstrapSessionProjection = z.infer<
  typeof projectBootstrapSessionProjectionSchema
>;

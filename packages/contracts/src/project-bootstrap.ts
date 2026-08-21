import { z } from "zod";
import { sha256Schema } from "./hash.js";
import {
  principalIdSchema,
  productRunIdSchema,
  productSessionIdSchema,
  projectBootstrapCandidateIdSchema,
  projectBootstrapDecisionIdSchema,
  projectBootstrapOperationIdSchema,
  projectWorkspaceBindingIdSchema,
} from "./ids.js";
import { promptWorkspaceRootIdSchema } from "./prompt-fragment.js";

/**
 * Plane CE只是项目管理事实源；Chat只保存初始化候选、外部操作结果和稳定绑定。
 * 这里故意不复制Plane Work Item/State/Cycle，也不保存Credential或绝对本机路径。
 */
export const PROJECT_BOOTSTRAP_SCHEMA_VERSION = "project-bootstrap.v1";

export const planeCeWorkspaceSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/u)
  .max(80);

export const planeCeProjectIdentifierSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]{0,11}$/u)
  .max(12);

export const planeCeProjectIdSchema = z.uuid();

export const projectDirectoryNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u)
  .refine((value) => value !== "." && value !== "..", "目录名不能是点路径");

export const projectBootstrapInitializerProfileSchema = z.enum(["blank", "ai_learning"]);

export const projectBootstrapProposalSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    objective: z.string().trim().min(1).max(4_000),
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    planeProjectIdentifier: planeCeProjectIdentifierSchema,
    workspaceRootId: promptWorkspaceRootIdSchema,
    directoryName: projectDirectoryNameSchema,
    initializerProfile: projectBootstrapInitializerProfileSchema,
    initialModules: z.array(z.string().trim().min(1).max(120)).max(8),
  })
  .strict();

export const projectBootstrapPreviewSchema = z
  .object({
    planeProjectLabel: z.string().min(1).max(300),
    workspaceLabel: z.string().min(1).max(500),
    gitAction: z.literal("initialize"),
    initialModules: z.array(z.string().min(1).max(120)).max(8),
  })
  .strict();

export const projectBootstrapCandidateStatusSchema = z.enum([
  "prepared",
  "confirmed",
  "rejected",
  "executing",
  "ready",
  "needs_attention",
  "outcome_unknown",
]);

export const projectBootstrapCandidateSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_BOOTSTRAP_SCHEMA_VERSION),
    projectBootstrapCandidateId: projectBootstrapCandidateIdSchema,
    ownerPrincipalId: principalIdSchema,
    sourceProductSessionId: productSessionIdSchema,
    sourceProductRunId: productRunIdSchema,
    proposal: projectBootstrapProposalSchema,
    preview: projectBootstrapPreviewSchema,
    status: projectBootstrapCandidateStatusSchema,
    sha256: sha256Schema,
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

/**
 * 初始化会同时创建外部Plane Project与本机Git目录，必须保留一次可读、可修订、
 * 与候选revision/hash绑定的显式决定；Agent的工具调用本身不能代替用户确认。
 */
export const projectBootstrapDecisionSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_BOOTSTRAP_SCHEMA_VERSION),
    projectBootstrapDecisionId: projectBootstrapDecisionIdSchema,
    projectBootstrapCandidateId: projectBootstrapCandidateIdSchema,
    candidateRevision: z.number().int().positive(),
    candidateSha256: sha256Schema,
    decidedByPrincipalId: principalIdSchema,
    kind: z.enum(["confirm", "reject"]),
    reason: z.string().trim().min(1).max(1_000).optional(),
    decidedAt: z.iso.datetime(),
  })
  .strict();

export const projectBootstrapOperationStatusSchema = z.enum([
  "queued",
  "dispatching",
  "ready",
  "failed",
  "needs_attention",
  "outcome_unknown",
]);

const operationStepStatusSchema = z.enum(["pending", "completed", "failed", "outcome_unknown"]);

export const projectBootstrapOperationSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_BOOTSTRAP_SCHEMA_VERSION),
    projectBootstrapOperationId: projectBootstrapOperationIdSchema,
    projectBootstrapCandidateId: projectBootstrapCandidateIdSchema,
    projectBootstrapDecisionId: projectBootstrapDecisionIdSchema,
    candidateSha256: sha256Schema,
    ownerPrincipalId: principalIdSchema,
    status: projectBootstrapOperationStatusSchema,
    workspaceStep: operationStepStatusSchema,
    planeStep: operationStepStatusSchema,
    bindingStep: operationStepStatusSchema,
    planeProjectId: planeCeProjectIdSchema.optional(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,119}$/u)
      .optional(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const projectWorkspaceBindingSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_BOOTSTRAP_SCHEMA_VERSION),
    projectWorkspaceBindingId: projectWorkspaceBindingIdSchema,
    ownerPrincipalId: principalIdSchema,
    productSessionId: productSessionIdSchema,
    projectBootstrapOperationId: projectBootstrapOperationIdSchema,
    providerKind: z.literal("plane_ce"),
    planeWorkspaceSlug: planeCeWorkspaceSlugSchema,
    planeProjectId: planeCeProjectIdSchema,
    planeProjectIdentifier: planeCeProjectIdentifierSchema,
    workspaceRootId: promptWorkspaceRootIdSchema,
    directoryName: projectDirectoryNameSchema,
    status: z.enum(["active", "archived"]),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type ProjectBootstrapProposal = z.infer<typeof projectBootstrapProposalSchema>;
export type PlaneCeProjectId = z.infer<typeof planeCeProjectIdSchema>;
export type ProjectBootstrapPreview = z.infer<typeof projectBootstrapPreviewSchema>;
export type ProjectBootstrapCandidate = z.infer<typeof projectBootstrapCandidateSchema>;
export type ProjectBootstrapDecision = z.infer<typeof projectBootstrapDecisionSchema>;
export type ProjectBootstrapOperation = z.infer<typeof projectBootstrapOperationSchema>;
export type ProjectWorkspaceBinding = z.infer<typeof projectWorkspaceBindingSchema>;

import { z } from "zod";
import { commandIdSchema, outboxEntryIdSchema, projectCandidateIdSchema } from "./ids.js";

export const PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION = "project-intake-workflow.v1";

export const prepareProjectCandidateRequestSchema = z
  .object({
    schemaVersion: z.literal("chat-internal-runtime.v1"),
    commandId: commandIdSchema,
    projectCandidateId: projectCandidateIdSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const projectIntakeWorkflowDispatchRequestSchema = z
  .object({
    schemaVersion: z.literal("chat-workflow-dispatch.v1"),
    workflowDefinitionVersion: z.literal(PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION),
    projectCandidateId: projectCandidateIdSchema,
    expectedCandidateRevision: z.number().int().positive(),
    outboxId: outboxEntryIdSchema,
  })
  .strict();

export const projectIntakeWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal("project-intake-workflow-input.v1"),
    projectCandidateId: projectCandidateIdSchema,
    expectedCandidateRevision: z.number().int().positive(),
  })
  .strict();

export const projectIntakeHookPayloadSchema = z
  .object({
    schemaVersion: z.literal("project-intake-hook-payload.v1"),
    projectCandidateId: projectCandidateIdSchema,
    candidateRevision: z.number().int().positive(),
  })
  .strict();

export type PrepareProjectCandidateRequest = z.infer<typeof prepareProjectCandidateRequestSchema>;
export type ProjectIntakeWorkflowDispatchRequest = z.infer<
  typeof projectIntakeWorkflowDispatchRequestSchema
>;
export type ProjectIntakeWorkflowInput = z.infer<typeof projectIntakeWorkflowInputSchema>;

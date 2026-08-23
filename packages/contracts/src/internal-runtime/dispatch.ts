/**
 * 内部Runtime合同 dispatch 族。对外经../internal-runtime.js barrel。
 */
import { z } from "zod";
import {
  approvalRequestIdSchema,
  decisionIdSchema,
  outboxEntryIdSchema,
  productRunIdSchema,
  runAttemptIdSchema,
  noteCandidateIdSchema,
  noteDecisionIdSchema,
  workflowRunSpecIdSchema,
  promptReviewDecisionIdSchema,
  promptReviewRequestIdSchema,
} from "../ids.js";
import { sha256Schema } from "../hash.js";
import { workflowRunnerFamilySchema } from "../workflow-definition.js";

export const WORKFLOW_DISPATCH_SCHEMA_VERSION = "chat-workflow-dispatch.v1";

export const workflowStartRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    workflowRunSpecId: workflowRunSpecIdSchema.optional(),
    runnerFamily: workflowRunnerFamilySchema.optional(),
    runnerBundleVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    /** 关联的workflow Run Attempt（Trace关联用，不是Runtime私有身份）。 */
    attemptId: runAttemptIdSchema,
    workflowDefinitionVersion: z.string().min(1),
    outboxId: outboxEntryIdSchema,
  })
  .strict()
  .check((ctx) => {
    const value = ctx.value;
    if (value.runnerFamily === undefined || value.runnerBundleVersion === undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "Workflow Start必须携带冻结Runner身份",
        path: ["runnerFamily"],
      });
      return;
    }
    if (
      (value.runnerFamily === "configurable-planning.v1" ||
        value.runnerFamily === "note-capture.v1" ||
        value.runnerFamily === "direct-agent.v1") &&
      value.workflowRunSpecId === undefined
    ) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "Definition Runner必须携带Workflow RunSpec",
        path: ["workflowRunSpecId"],
      });
    }
    if (value.runnerFamily === "legacy-planning.v1" && value.workflowRunSpecId !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "Legacy Runner不得携带Workflow RunSpec",
        path: ["workflowRunSpecId"],
      });
    }
    if (value.runnerFamily === "definition-kernel-lab.v1") {
      ctx.issues.push({
        code: "custom",
        input: value,
        message: "实验室Runner不得通过正式派发边界启动",
        path: ["runnerFamily"],
      });
    }
  });

export const workflowStartResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["started", "already_started", "outcome_unknown"]),
  })
  .strict();

export const workflowDispatchBase = {
  schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
  productRunId: productRunIdSchema,
  attemptId: runAttemptIdSchema,
  outboxId: outboxEntryIdSchema,
};

export const workflowPlanningResumeRequestSchema = z
  .object({
    ...workflowDispatchBase,
    approvalRequestId: approvalRequestIdSchema,
    decisionId: decisionIdSchema,
  })
  .strict();

export const workflowNoteResumeRequestSchema = z
  .object({
    ...workflowDispatchBase,
    hookNoteCandidateId: noteCandidateIdSchema,
    noteCandidateId: noteCandidateIdSchema,
    noteDecisionId: noteDecisionIdSchema,
  })
  .strict();

export const workflowPromptReviewResumeRequestSchema = z
  .object({
    ...workflowDispatchBase,
    promptReviewRequestId: promptReviewRequestIdSchema,
    promptReviewDecisionId: promptReviewDecisionIdSchema,
    requestRevision: z.number().int().positive(),
    reviewSha256: sha256Schema,
    payloadSha256: sha256Schema,
  })
  .strict();

export const workflowResumeRequestSchema = z.union([
  workflowPlanningResumeRequestSchema,
  workflowNoteResumeRequestSchema,
  workflowPromptReviewResumeRequestSchema,
]);

export const workflowResumeResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    status: z.enum(["resumed", "already_resumed", "outcome_unknown"]),
  })
  .strict();

export const workflowRuntimeTerminalOutcomeSchema = z.enum([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
]);
export type WorkflowRuntimeTerminalOutcome = z.infer<typeof workflowRuntimeTerminalOutcomeSchema>;

export const workflowRuntimeRunEvidenceSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("active") }),
  z.strictObject({
    state: z.literal("terminal"),
    outcome: workflowRuntimeTerminalOutcomeSchema,
  }),
  z.strictObject({ state: z.literal("unknown") }),
]);

/**
 * 对账查询只返回绑定存在性、派发状态与归一终态证据；Runtime Run ID、返回正文、
 * 错误Payload和Checkpoint都留在Adapter内，不能成为产品身份或进入监督日志。
 */
export const workflowReconcileResponseSchema = z
  .object({
    schemaVersion: z.literal(WORKFLOW_DISPATCH_SCHEMA_VERSION),
    productRunId: productRunIdSchema,
    startBinding: z.enum(["exists", "missing", "outcome_unknown"]),
    hookResumeState: z
      .enum(["none", "dispatching", "dispatched", "outcome_unknown", "failed_terminal", "missing"])
      .optional(),
    runtimeRun: workflowRuntimeRunEvidenceSchema.optional(),
  })
  .strict();

/* ---------- Memory Import Workflow 私有合同 ---------- */

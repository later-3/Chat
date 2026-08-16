import {
  approvalDtoSchema,
  approvalRequestIdSchema,
  decisionDtoSchema,
  messageDtoSchema,
  messageResponseSchema,
  planIdSchema,
  planDtoSchema,
  productRunIdSchema,
  runDtoSchema,
  sessionDtoSchema,
  sha256Schema,
  type ApprovalDto,
  type DecisionDto,
  type MessageDto,
  type PlanDto,
  type RunDto,
  type SessionDto,
} from "@chat/contracts/public";
import { z } from "zod";

export const BRIDGE_SCHEMA_VERSION = "chat-dsh-lifeos-bridge.v1" as const;
export const dshSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value));

// Aliases keep the adapter vocabulary concise while the runtime authority stays
// in @chat/contracts/public and is inlined into the deployable bridge bundle.
export const sessionSchema = sessionDtoSchema;
export const messageSchema = messageDtoSchema;
export const planSchema = planDtoSchema;
export const approvalSchema = approvalDtoSchema;
export const runSchema = runDtoSchema;
export const decisionKindSchema = decisionDtoSchema.shape.kind;

export const problemSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    status: z.number().int().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    requestId: z.string().optional(),
    retryable: z.boolean().optional(),
    recoveryAction: z.string().optional(),
  })
  .loose();

export const createSessionResponseSchema = z.object({ session: sessionDtoSchema }).strict();
export const submitMessageResponseSchema = z
  .object({ message: messageDtoSchema, run: runDtoSchema })
  .strict();
export const runResponseSchema = z.object({ run: runDtoSchema }).strict();
export const plansResponseSchema = z.object({ items: z.array(planDtoSchema) }).strict();
export const approvalResponseSchema = z.object({ approval: approvalDtoSchema.nullable() }).strict();
export const exactMessageResponseSchema = messageResponseSchema;
export const decisionResponseSchema = z
  .object({ decision: decisionDtoSchema, run: runDtoSchema })
  .strict();

/** Browser-to-bridge command. Product binding fields are resolved Host-side. */
export const decisionRequestSchema = z
  .object({
    kind: decisionKindSchema,
    explanation: z.string().trim().min(1).max(2_000).optional(),
    binding: z
      .object({
        productRunId: productRunIdSchema,
        runRevision: z.number().int().positive(),
        approvalRequestId: approvalRequestIdSchema,
        planId: planIdSchema,
        planRevision: z.number().int().positive(),
        planSha256: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "request_revision" && value.explanation === undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "修订请求必须填写说明" });
    }
    if (value.kind === "approve" && value.explanation !== undefined) {
      ctx.addIssue({ code: "custom", path: ["explanation"], message: "批准不接受额外说明" });
    }
  });

export type ChatSession = SessionDto;
export type ChatMessage = MessageDto;
export type ChatPlan = PlanDto;
export type ChatApproval = ApprovalDto;
export type ChatRun = RunDto;
export type ChatDecision = DecisionDto;
export type DecisionKind = z.infer<typeof decisionKindSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

export const publicRunSchema = runDtoSchema.pick({
  productRunId: true,
  status: true,
  phase: true,
  failure: true,
  allowedActions: true,
  revision: true,
  updatedAt: true,
});

/** Same-origin Client read model; no Workflow/pi/runtime-private identity exists. */
export const lifeosProjectionSchema = z
  .object({
    schemaVersion: z.literal(BRIDGE_SCHEMA_VERSION),
    dshSessionId: dshSessionIdSchema,
    run: publicRunSchema.nullable(),
    plan: planDtoSchema.nullable(),
    approval: approvalDtoSchema.nullable(),
    pendingDecision: decisionRequestSchema.nullable(),
  })
  .strict();

export type LifeosProjection = z.infer<typeof lifeosProjectionSchema>;

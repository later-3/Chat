import { z } from "zod";
import { directAgentCandidateIdSchema, productRunIdSchema, runAttemptIdSchema } from "./ids.js";
import { sha256Schema } from "./hash.js";

/**
 * Direct Agent模型输出只能先成为候选，不能直接成为正式Assistant Message。
 * 候选绑定一次运行中的Direct Agent Attempt及其冻结输入证据；Product Commit属于后续用例。
 */
export const directAgentCandidateOutputSchema = z
  .object({
    format: z.literal("markdown"),
    text: z.string().min(1).max(100_000),
  })
  .strict();

export const directAgentCandidateSchema = z
  .object({
    schemaVersion: z.literal("direct-agent-candidate.v1"),
    directAgentCandidateId: directAgentCandidateIdSchema,
    productRunId: productRunIdSchema,
    directAgentAttemptId: runAttemptIdSchema,
    output: directAgentCandidateOutputSchema,
    sha256: sha256Schema,
    revision: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export type DirectAgentCandidateOutput = z.infer<typeof directAgentCandidateOutputSchema>;
export type DirectAgentCandidate = z.infer<typeof directAgentCandidateSchema>;

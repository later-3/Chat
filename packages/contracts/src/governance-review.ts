import { z } from "zod";
import { promptAssemblyIdSchema, runAttemptIdSchema } from "./ids.js";
import { sha256Schema } from "./hash.js";

export const GOVERNANCE_REVIEW_PROFILE_VERSION = "governance-review.v1" as const;
export const GOVERNANCE_REVIEW_MAX_TURNS = 1;
export const GOVERNANCE_REVIEW_TOKEN_BUDGET = 4_096;
export const GOVERNANCE_REVIEW_ACTIVE_TIMEOUT_MS = 90_000;

export const governanceEvidenceKeySchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^(candidate|step|tool):[A-Za-z0-9._:@-]+$/u);

export const governanceReviewFindingSchema = z
  .object({
    severity: z.enum(["blocking", "advisory"]),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
      .max(64),
    summary: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(1_000),
    evidenceKeys: z.array(governanceEvidenceKeySchema).min(1).max(20),
  })
  .strict();

/** 模型只提交检查候选；Application仍要复核证据键并决定能否形成Validation事实。 */
export const governanceReviewCandidateSchema = z
  .object({
    schemaVersion: z.literal("governance-review-candidate.v1"),
    outcome: z.enum(["pass", "fail"]),
    summary: z.string().trim().min(1).max(1_000),
    findings: z.array(governanceReviewFindingSchema).max(50),
    residualRisks: z.array(z.string().trim().min(1).max(500)).max(20),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    const hasBlocking = candidate.findings.some((finding) => finding.severity === "blocking");
    if ((candidate.outcome === "fail") !== hasBlocking) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "fail必须且只能对应至少一个blocking finding",
      });
    }
  });

/** Validation内冻结实际采用的节点Prompt引用和已校验候选；正文仍只属于Prompt Assembly。 */
export const governanceReviewRecordSchema = z
  .object({
    profileVersion: z.literal(GOVERNANCE_REVIEW_PROFILE_VERSION),
    attemptId: runAttemptIdSchema,
    inputManifestSha256: sha256Schema,
    promptAssemblyId: promptAssemblyIdSchema,
    promptAssemblySha256: sha256Schema,
    nodeAssemblySha256: sha256Schema,
    candidate: governanceReviewCandidateSchema,
  })
  .strict();

export type GovernanceReviewCandidate = z.infer<typeof governanceReviewCandidateSchema>;
export type GovernanceReviewRecord = z.infer<typeof governanceReviewRecordSchema>;

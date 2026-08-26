import { z } from "zod";
import { sha256Schema } from "./hash.js";
import { runAttemptIdSchema } from "./ids.js";

/** Pi Journal完整校验后返回给Application的内容寻址窄Receipt。 */
export const executionEvidenceVerificationReceiptSchema = z
  .object({
    schemaVersion: z.literal("execution-evidence-verification-receipt.v1"),
    executionAttemptId: runAttemptIdSchema,
    evidenceRefsSha256: sha256Schema,
    journalSha256: sha256Schema,
  })
  .strict();

export type ExecutionEvidenceVerificationReceipt = z.infer<
  typeof executionEvidenceVerificationReceiptSchema
>;

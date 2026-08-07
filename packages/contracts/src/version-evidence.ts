import { z } from "zod";
import { productRunIdSchema } from "./ids.js";

const gitShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
const versionListSchema = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)).max(20);

const versionFields = {
  gitSha: gitShaSchema,
  sourceState: z.enum(["clean", "dirty"]),
  sourceManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bundleManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  workflowDefinitionVersions: versionListSchema,
  promptTemplateVersions: versionListSchema,
  modelConfigVersions: versionListSchema,
};

/** Workflow bundle构建时冻结；运行时只能读取，不能用当前HEAD重新生成。 */
export const runtimeBuildEvidenceSchema = z
  .object({
    schemaVersion: z.literal("chat-runtime-build-evidence.v1"),
    builtAt: z.iso.datetime(),
    ...versionFields,
  })
  .strict();

/** Workflow Start时按Product Run复制保存的历史版本证据。 */
export const runtimeVersionEvidenceSchema = z
  .object({
    schemaVersion: z.literal("chat-runtime-version-evidence.v1"),
    productRunId: productRunIdSchema,
    capturedAt: z.iso.datetime(),
    ...versionFields,
  })
  .strict();

export type RuntimeBuildEvidence = z.infer<typeof runtimeBuildEvidenceSchema>;
export type RuntimeVersionEvidence = z.infer<typeof runtimeVersionEvidenceSchema>;

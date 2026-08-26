import { z } from "zod";
import { sha256Schema } from "./hash.js";

export const contentLabRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !value.includes("\0"),
    { message: "Content Lab路径必须是Root内的POSIX相对路径" },
  );

export const contentLabFileRefSchema = z
  .object({
    relativePath: contentLabRelativePathSchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const contentLabArtifactSchema = z
  .object({
    relativePath: contentLabRelativePathSchema,
    mediaKind: z.enum(["video", "image", "audio", "caption", "metadata", "other"]),
    hashPolicy: z.enum(["computed", "deferred_large", "deferred_policy", "missing"]),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: sha256Schema.optional(),
    metadata: z
      .object({
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        durationSeconds: z.number().nonnegative().optional(),
        frameRate: z.number().positive().optional(),
        codec: z.string().trim().min(1).max(40).optional(),
      })
      .strict()
      .optional(),
    recommendedBy: z.array(contentLabRelativePathSchema).min(1).max(5),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.hashPolicy === "computed" && artifact.sha256 === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "已计算Hash的工件必须带sha256",
      });
    }
    if (artifact.hashPolicy !== "computed" && artifact.sha256 !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "未计算Hash的工件不能伪造sha256",
      });
    }
    if (artifact.hashPolicy !== "missing" && artifact.sizeBytes === undefined) {
      context.addIssue({ code: "custom", path: ["sizeBytes"], message: "存在的工件必须记录大小" });
    }
    if (artifact.hashPolicy === "missing" && artifact.sizeBytes !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sizeBytes"],
        message: "缺失工件不能记录虚假大小",
      });
    }
  });

export const contentLabJobSchema = z
  .object({
    jobKey: contentLabRelativePathSchema,
    platform: z.enum(["xiaohongshu", "bilibili"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    seriesKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u)
      .optional(),
    source: contentLabFileRefSchema.optional(),
    publish: contentLabFileRefSchema.optional(),
    qc: contentLabFileRefSchema.optional(),
    workflowAnalysis: contentLabFileRefSchema.optional(),
    sourceUrls: z.array(z.url()).max(10),
    workflowRevisionRefs: z.array(contentLabRelativePathSchema).max(20),
    readiness: z.enum(["draft", "needs_review", "review_ready", "blocked"]),
    blockerSignals: z.array(z.string().trim().min(1).max(240)).max(12),
    recommendedArtifacts: z.array(contentLabArtifactSchema).max(12),
    fingerprintSha256: sha256Schema,
  })
  .strict();

export const contentLabObservationSchema = z
  .object({
    schemaVersion: z.literal("content-lab-observation.v1"),
    catalog: z
      .object({
        governance: z.array(contentLabFileRefSchema).max(30),
        workflows: z.array(contentLabFileRefSchema).max(100),
        templates: z.array(contentLabFileRefSchema).max(100),
        seriesRegistries: z.array(contentLabFileRefSchema).max(100),
        cases: z.array(contentLabFileRefSchema).max(500),
      })
      .strict(),
    jobs: z.array(contentLabJobSchema).max(500),
    scanStats: z
      .object({
        trackedFileCount: z.number().int().nonnegative(),
        relevantTextFileCount: z.number().int().nonnegative(),
        candidateJobCount: z.number().int().nonnegative(),
        selectedArtifactCount: z.number().int().nonnegative(),
        ignoredTrackedMediaCount: z.number().int().nonnegative(),
        hashedArtifactBytes: z.number().int().nonnegative(),
        artifactInspectionPolicy: z.literal("recommended_paths_only"),
        truncated: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const contentLabChangeCandidateSchema = z
  .object({
    schemaVersion: z.literal("content-lab-change-candidate.v1"),
    classification: z.enum(["baseline", "none", "review_required"]),
    changeKinds: z
      .array(z.enum(["governance", "workflow", "template", "series", "work_evidence", "case"]))
      .max(6),
    changedPaths: z.array(contentLabRelativePathSchema).max(200),
    summary: z.string().trim().min(1).max(500),
    prohibitsAutomaticCompletion: z.literal(true),
  })
  .strict()
  .superRefine((candidate, context) => {
    const changed = candidate.classification === "review_required";
    if (
      changed !== candidate.changedPaths.length > 0 ||
      changed !== candidate.changeKinds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["changedPaths"],
        message: "只有review_required候选才能且必须列出变化",
      });
    }
  });

export const contentLabContextSelectionSchema = z
  .object({
    workKind: z.enum(["content_delivery", "workflow_improvement"]),
    targetPlatforms: z.array(z.enum(["xiaohongshu", "bilibili"])).max(2),
    sourceRef: z.string().trim().min(1).max(500).optional(),
    seriesKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,119}$/u)
      .optional(),
    resourceRefs: z.array(z.string().trim().min(1).max(500)).max(50),
  })
  .strict();

export const contentLabContextBundleSchema = z
  .object({
    schemaVersion: z.literal("content-lab-context-bundle.v1"),
    observationSha256: sha256Schema,
    selectedJobKeys: z.array(contentLabRelativePathSchema).max(5),
    items: z
      .array(
        z
          .object({
            role: z.enum([
              "governance",
              "workflow",
              "template",
              "series_rule",
              "current_job",
              "case",
            ]),
            relativePath: contentLabRelativePathSchema,
            sha256: sha256Schema,
            sizeBytes: z.number().int().nonnegative(),
            reason: z.string().trim().min(1).max(240),
            content: z.string().max(40_000),
          })
          .strict(),
      )
      .max(30),
    history: z
      .array(
        z
          .object({
            jobKey: contentLabRelativePathSchema,
            platform: z.enum(["xiaohongshu", "bilibili"]),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
            seriesKey: z.string().optional(),
            readiness: z.enum(["draft", "needs_review", "review_ready", "blocked"]),
            sourceUrls: z.array(z.url()).max(10),
            workflowRevisionRefs: z.array(contentLabRelativePathSchema).max(20),
          })
          .strict(),
      )
      .max(20),
    totalCharacters: z.number().int().nonnegative(),
    excludedItemCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type ContentLabFileRef = z.infer<typeof contentLabFileRefSchema>;
export type ContentLabArtifact = z.infer<typeof contentLabArtifactSchema>;
export type ContentLabJob = z.infer<typeof contentLabJobSchema>;
export type ContentLabObservation = z.infer<typeof contentLabObservationSchema>;
export type ContentLabChangeCandidate = z.infer<typeof contentLabChangeCandidateSchema>;
export type ContentLabContextSelection = z.infer<typeof contentLabContextSelectionSchema>;
export type ContentLabContextBundle = z.infer<typeof contentLabContextBundleSchema>;

import { z } from "zod";
import {
  approvalRequestIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  memoryWriteIntentIdSchema,
  memoryWriteResultIdSchema,
  noteCandidateIdSchema,
  outboxEntryIdSchema,
  productRunIdSchema,
  projectCandidateIdSchema,
  type OutboxEntryId,
  type ProductRunId,
  type ProjectCandidateId,
} from "@chat/contracts";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  LEGACY_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_FAMILY,
  type ProductWorkflowRunnerFamily,
} from "./definition-kernel-executor-registry.js";

export const RUNTIME_BINDINGS_SCHEMA_VERSION = "runtime-bindings.v6";

const legacyStartIntentSchema = z
  .object({
    outboxId: outboxEntryIdSchema,
    workflowDefinitionVersion: z.string().min(1).max(100),
    state: z.enum(["starting", "outcome_unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const legacyWorkflowBindingSchema = z
  .object({
    workflowRunId: z.string().min(1).max(200),
    workflowDefinitionVersion: z.string().min(1).max(100),
    startDispatchState: z.literal("started"),
    createdAt: z.iso.datetime(),
  })
  .strict();

const productWorkflowRunnerFamilySchema = z.enum([
  LEGACY_PLANNING_RUNNER_FAMILY,
  CONFIGURABLE_PLANNING_RUNNER_FAMILY,
  NOTE_CAPTURE_RUNNER_FAMILY,
]);

const startIntentSchema = legacyStartIntentSchema
  .extend({
    runnerFamily: productWorkflowRunnerFamilySchema,
    runnerBundleVersion: z.string().min(1).max(128),
    workflowRunSpecId: z
      .string()
      .regex(/^wrs_[A-Za-z0-9]+$/)
      .optional(),
  })
  .strict()
  .superRefine(assertProductRunnerEvidence);

const workflowBindingSchema = legacyWorkflowBindingSchema
  .extend({
    runnerFamily: productWorkflowRunnerFamilySchema,
    runnerBundleVersion: z.string().min(1).max(128),
    workflowRunSpecId: z
      .string()
      .regex(/^wrs_[A-Za-z0-9]+$/)
      .optional(),
  })
  .strict()
  .superRefine(assertProductRunnerEvidence);

function assertProductRunnerEvidence(
  value: {
    readonly runnerFamily: ProductWorkflowRunnerFamily;
    readonly runnerBundleVersion: string;
    readonly workflowRunSpecId?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const legacy = value.runnerFamily === LEGACY_PLANNING_RUNNER_FAMILY;
  const expectedBundle =
    value.runnerFamily === LEGACY_PLANNING_RUNNER_FAMILY
      ? LEGACY_PLANNING_RUNNER_BUNDLE_VERSION
      : value.runnerFamily === CONFIGURABLE_PLANNING_RUNNER_FAMILY
        ? CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION
        : NOTE_CAPTURE_RUNNER_BUNDLE_VERSION;
  const bundleMatches = value.runnerBundleVersion === expectedBundle;
  if (!bundleMatches) {
    context.addIssue({
      code: "custom",
      path: ["runnerBundleVersion"],
      message: "Runner family与bundle版本不匹配",
    });
  }
  if (legacy === (value.workflowRunSpecId !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["workflowRunSpecId"],
      message: legacy ? "Legacy Runner不能绑定RunSpec" : "Configurable Runner必须绑定RunSpec",
    });
  }
}

const hookBindingSchema = z
  .object({
    hookToken: z.string().min(1).max(300),
    productRunId: productRunIdSchema,
    planRevision: z.number().int().positive(),
    hookClaimState: z.literal("claimed"),
    resumeDispatchState: z.enum([
      "none",
      "dispatching",
      "dispatched",
      "outcome_unknown",
      "failed_terminal",
    ]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const noteHookBindingSchema = z
  .object({
    hookToken: z.string().min(1).max(300),
    productRunId: productRunIdSchema,
    candidateSequence: z.number().int().positive(),
    hookClaimState: z.literal("claimed"),
    resumeDispatchState: z.enum([
      "none",
      "dispatching",
      "dispatched",
      "outcome_unknown",
      "failed_terminal",
    ]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const memoryImportStartIntentSchema = z
  .object({
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
    mode: z.enum(["import", "reconcile"]),
    workflowDefinitionVersion: z.string().min(1).max(100),
    state: z.enum(["starting", "outcome_unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const memoryImportWorkflowBindingSchema = z
  .object({
    memoryImportIntentId: memoryImportIntentIdSchema,
    memoryImportResultId: memoryImportResultIdSchema,
    mode: z.enum(["import", "reconcile"]),
    workflowRunId: z.string().min(1).max(200),
    workflowDefinitionVersion: z.string().min(1).max(100),
    startDispatchState: z.literal("started"),
    createdAt: z.iso.datetime(),
  })
  .strict();

const memoryWriteStartIntentSchema = z
  .object({
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
    mode: z.enum(["write", "reconcile"]),
    workflowDefinitionVersion: z.string().min(1).max(100),
    state: z.enum(["starting", "outcome_unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const memoryWriteWorkflowBindingSchema = z
  .object({
    memoryWriteIntentId: memoryWriteIntentIdSchema,
    memoryWriteResultId: memoryWriteResultIdSchema,
    mode: z.enum(["write", "reconcile"]),
    workflowRunId: z.string().min(1).max(200),
    workflowDefinitionVersion: z.string().min(1).max(100),
    startDispatchState: z.literal("started"),
    createdAt: z.iso.datetime(),
  })
  .strict();

/**
 * v3落盘字段沿用PS1的projectIntake命名以保持兼容；其语义已经是通用Project
 * Candidate Workflow绑定，Definition Version区分Intake与Advancement。
 */
const projectIntakeStartIntentSchema = z
  .object({
    outboxId: outboxEntryIdSchema,
    workflowDefinitionVersion: z.string().min(1).max(100),
    state: z.enum(["starting", "outcome_unknown"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const projectIntakeWorkflowBindingSchema = z
  .object({
    startOutboxId: outboxEntryIdSchema,
    workflowRunId: z.string().min(1).max(200),
    workflowDefinitionVersion: z.string().min(1).max(100),
    hookToken: z.string().min(1).max(300),
    resumeDispatchState: z.enum([
      "none",
      "dispatching",
      "dispatched",
      "outcome_unknown",
      "failed_terminal",
    ]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const runtimeBindingsFileV1Schema = z
  .object({
    schemaVersion: z.literal("runtime-bindings.v1"),
    startIntents: z.record(productRunIdSchema, legacyStartIntentSchema).default({}),
    workflows: z.record(productRunIdSchema, legacyWorkflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
  })
  .strict();

const runtimeBindingsFileV2Schema = z
  .object({
    schemaVersion: z.literal("runtime-bindings.v2"),
    startIntents: z.record(productRunIdSchema, legacyStartIntentSchema),
    workflows: z.record(productRunIdSchema, legacyWorkflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
    memoryImportStartIntents: z.record(outboxEntryIdSchema, memoryImportStartIntentSchema),
    memoryImportWorkflows: z.record(outboxEntryIdSchema, memoryImportWorkflowBindingSchema),
  })
  .strict();

const runtimeBindingsFileV3Schema = z
  .object({
    schemaVersion: z.literal("runtime-bindings.v3"),
    startIntents: z.record(productRunIdSchema, legacyStartIntentSchema),
    workflows: z.record(productRunIdSchema, legacyWorkflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
    memoryImportStartIntents: z.record(outboxEntryIdSchema, memoryImportStartIntentSchema),
    memoryImportWorkflows: z.record(outboxEntryIdSchema, memoryImportWorkflowBindingSchema),
    projectIntakeStartIntents: z.record(projectCandidateIdSchema, projectIntakeStartIntentSchema),
    projectIntakeWorkflows: z.record(projectCandidateIdSchema, projectIntakeWorkflowBindingSchema),
  })
  .strict();

const runtimeBindingsFileV4Schema = z
  .object({
    schemaVersion: z.literal("runtime-bindings.v4"),
    startIntents: z.record(productRunIdSchema, startIntentSchema),
    workflows: z.record(productRunIdSchema, workflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
    memoryImportStartIntents: z.record(outboxEntryIdSchema, memoryImportStartIntentSchema),
    memoryImportWorkflows: z.record(outboxEntryIdSchema, memoryImportWorkflowBindingSchema),
    projectIntakeStartIntents: z.record(projectCandidateIdSchema, projectIntakeStartIntentSchema),
    projectIntakeWorkflows: z.record(projectCandidateIdSchema, projectIntakeWorkflowBindingSchema),
  })
  .strict();

const runtimeBindingsFileV5Schema = z
  .object({
    schemaVersion: z.literal("runtime-bindings.v5"),
    startIntents: z.record(productRunIdSchema, startIntentSchema),
    workflows: z.record(productRunIdSchema, workflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
    noteHooks: z.record(noteCandidateIdSchema, noteHookBindingSchema),
    memoryImportStartIntents: z.record(outboxEntryIdSchema, memoryImportStartIntentSchema),
    memoryImportWorkflows: z.record(outboxEntryIdSchema, memoryImportWorkflowBindingSchema),
    projectIntakeStartIntents: z.record(projectCandidateIdSchema, projectIntakeStartIntentSchema),
    projectIntakeWorkflows: z.record(projectCandidateIdSchema, projectIntakeWorkflowBindingSchema),
  })
  .strict();

export const runtimeBindingsFileSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_BINDINGS_SCHEMA_VERSION),
    startIntents: z.record(productRunIdSchema, startIntentSchema),
    workflows: z.record(productRunIdSchema, workflowBindingSchema),
    hooks: z.record(approvalRequestIdSchema, hookBindingSchema),
    noteHooks: z.record(noteCandidateIdSchema, noteHookBindingSchema),
    memoryImportStartIntents: z.record(outboxEntryIdSchema, memoryImportStartIntentSchema),
    memoryImportWorkflows: z.record(outboxEntryIdSchema, memoryImportWorkflowBindingSchema),
    memoryWriteStartIntents: z.record(outboxEntryIdSchema, memoryWriteStartIntentSchema),
    memoryWriteWorkflows: z.record(outboxEntryIdSchema, memoryWriteWorkflowBindingSchema),
    projectIntakeStartIntents: z.record(projectCandidateIdSchema, projectIntakeStartIntentSchema),
    projectIntakeWorkflows: z.record(projectCandidateIdSchema, projectIntakeWorkflowBindingSchema),
  })
  .strict();

export type RuntimeBindingsFile = z.infer<typeof runtimeBindingsFileSchema>;
export type WorkflowBinding = z.infer<typeof workflowBindingSchema>;
export type HookBinding = z.infer<typeof hookBindingSchema>;
export type NoteHookBinding = z.infer<typeof noteHookBindingSchema>;
export type MemoryImportWorkflowBinding = z.infer<typeof memoryImportWorkflowBindingSchema>;
export type MemoryWriteWorkflowBinding = z.infer<typeof memoryWriteWorkflowBindingSchema>;
export type ProjectIntakeWorkflowBinding = z.infer<typeof projectIntakeWorkflowBindingSchema>;

export class RuntimeBindingError extends Error {
  readonly code = "runtime_binding_invalid";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBindingError";
  }
}

export function emptyBindings(): RuntimeBindingsFile {
  return {
    schemaVersion: RUNTIME_BINDINGS_SCHEMA_VERSION,
    startIntents: {},
    workflows: {},
    hooks: {},
    noteHooks: {},
    memoryImportStartIntents: {},
    memoryImportWorkflows: {},
    memoryWriteStartIntents: {},
    memoryWriteWorkflows: {},
    projectIntakeStartIntents: {},
    projectIntakeWorkflows: {},
  };
}

function withLegacyRunnerEvidence<T extends object>(
  value: T,
): T & {
  readonly runnerFamily: typeof LEGACY_PLANNING_RUNNER_FAMILY;
  readonly runnerBundleVersion: typeof LEGACY_PLANNING_RUNNER_BUNDLE_VERSION;
} {
  return {
    ...value,
    runnerFamily: LEGACY_PLANNING_RUNNER_FAMILY,
    runnerBundleVersion: LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  };
}

interface ProductRunnerEvidenceInput {
  readonly runnerFamily?: ProductWorkflowRunnerFamily | undefined;
  readonly runnerBundleVersion?: string | undefined;
  readonly workflowRunSpecId?: string | undefined;
}

export function normalizeProductRunnerEvidence(input: ProductRunnerEvidenceInput): {
  readonly runnerFamily: ProductWorkflowRunnerFamily;
  readonly runnerBundleVersion: string;
  readonly workflowRunSpecId?: string | undefined;
} {
  const runnerFamily = input.runnerFamily ?? LEGACY_PLANNING_RUNNER_FAMILY;
  const runnerBundleVersion =
    input.runnerBundleVersion ??
    (runnerFamily === LEGACY_PLANNING_RUNNER_FAMILY
      ? LEGACY_PLANNING_RUNNER_BUNDLE_VERSION
      : runnerFamily === CONFIGURABLE_PLANNING_RUNNER_FAMILY
        ? CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION
        : NOTE_CAPTURE_RUNNER_BUNDLE_VERSION);
  const parsed = z
    .object({
      runnerFamily: productWorkflowRunnerFamilySchema,
      runnerBundleVersion: z.string().min(1).max(128),
      workflowRunSpecId: z
        .string()
        .regex(/^wrs_[A-Za-z0-9]+$/)
        .optional(),
    })
    .strict()
    .superRefine(assertProductRunnerEvidence)
    .parse({
      runnerFamily,
      runnerBundleVersion,
      ...(input.workflowRunSpecId !== undefined
        ? { workflowRunSpecId: input.workflowRunSpecId }
        : {}),
    });
  return parsed;
}

export function parseRuntimeBindingsFile(parsed: unknown): {
  readonly bindings: RuntimeBindingsFile;
  readonly migrationRequired: boolean;
} {
  const validated = runtimeBindingsFileSchema.safeParse(parsed);
  if (validated.success) {
    assertRuntimeBindingsIntegrity(validated.data);
    return { bindings: validated.data, migrationRequired: false };
  }
  const legacyV5 = runtimeBindingsFileV5Schema.safeParse(parsed);
  const legacyV4 = legacyV5.success ? undefined : runtimeBindingsFileV4Schema.safeParse(parsed);
  const legacyV3 =
    legacyV5.success || legacyV4?.success === true
      ? undefined
      : runtimeBindingsFileV3Schema.safeParse(parsed);
  const legacyV2 =
    legacyV5.success || legacyV4?.success === true || legacyV3?.success === true
      ? undefined
      : runtimeBindingsFileV2Schema.safeParse(parsed);
  const legacyV1 =
    legacyV5.success ||
    legacyV4?.success === true ||
    legacyV3?.success === true ||
    legacyV2?.success === true
      ? undefined
      : runtimeBindingsFileV1Schema.safeParse(parsed);
  if (
    !legacyV5.success &&
    legacyV4?.success !== true &&
    legacyV3?.success !== true &&
    legacyV2?.success !== true &&
    legacyV1?.success !== true
  ) {
    throw new RuntimeBindingError("Runtime Binding Store版本未知或内容非法，已保留原文件");
  }
  const source = legacyV5.success
    ? legacyV5.data
    : legacyV4?.success === true
      ? legacyV4.data
      : legacyV3?.success === true
        ? legacyV3.data
        : legacyV2?.success === true
          ? {
              ...legacyV2.data,
              projectIntakeStartIntents: {},
              projectIntakeWorkflows: {},
            }
          : {
              ...legacyV1!.data,
              memoryImportStartIntents: {},
              memoryImportWorkflows: {},
              projectIntakeStartIntents: {},
              projectIntakeWorkflows: {},
            };
  const migratedStartIntents: RuntimeBindingsFile["startIntents"] = legacyV5.success
    ? legacyV5.data.startIntents
    : legacyV4?.success === true
      ? legacyV4.data.startIntents
      : Object.fromEntries(
          Object.entries(source.startIntents ?? {}).map(([productRunId, intent]) => [
            productRunId,
            withLegacyRunnerEvidence(intent),
          ]),
        );
  const migratedWorkflows: RuntimeBindingsFile["workflows"] = legacyV5.success
    ? legacyV5.data.workflows
    : legacyV4?.success === true
      ? legacyV4.data.workflows
      : Object.fromEntries(
          Object.entries(source.workflows ?? {}).map(([productRunId, binding]) => [
            productRunId,
            withLegacyRunnerEvidence(binding),
          ]),
        );
  const bindings: RuntimeBindingsFile = {
    schemaVersion: RUNTIME_BINDINGS_SCHEMA_VERSION,
    startIntents: migratedStartIntents,
    workflows: migratedWorkflows,
    hooks: source.hooks ?? {},
    noteHooks: {},
    memoryImportStartIntents: source.memoryImportStartIntents,
    memoryImportWorkflows: source.memoryImportWorkflows,
    memoryWriteStartIntents: {},
    memoryWriteWorkflows: {},
    projectIntakeStartIntents: source.projectIntakeStartIntents,
    projectIntakeWorkflows: source.projectIntakeWorkflows,
  };
  assertRuntimeBindingsIntegrity(bindings);
  return { bindings, migrationRequired: true };
}

export function assertRuntimeBindingsIntegrity(bindings: RuntimeBindingsFile): void {
  for (const productRunId of Object.keys(bindings.startIntents) as ProductRunId[]) {
    if (bindings.workflows[productRunId] !== undefined) {
      throw new RuntimeBindingError("同一Product Run不能同时存在start意图与Workflow映射");
    }
  }
  const workflowRunIds = Object.values(bindings.workflows).map((binding) => binding.workflowRunId);
  const importWorkflowRunIds = Object.values(bindings.memoryImportWorkflows).map(
    (binding) => binding.workflowRunId,
  );
  const memoryWriteWorkflowRunIds = Object.values(bindings.memoryWriteWorkflows).map(
    (binding) => binding.workflowRunId,
  );
  const allWorkflowRunIds = [
    ...workflowRunIds,
    ...importWorkflowRunIds,
    ...memoryWriteWorkflowRunIds,
  ];
  if (new Set(allWorkflowRunIds).size !== allWorkflowRunIds.length) {
    throw new RuntimeBindingError("多个产品操作不能共享同一Workflow Run映射");
  }
  const hookTokens = Object.values(bindings.hooks).map((binding) => binding.hookToken);
  if (new Set(hookTokens).size !== hookTokens.length) {
    throw new RuntimeBindingError("多个Approval不能共享同一Hook Token");
  }
  for (const hook of Object.values(bindings.hooks)) {
    if (bindings.workflows[hook.productRunId] === undefined) {
      throw new RuntimeBindingError("Hook映射缺少对应Workflow映射");
    }
  }
  const noteHookTokens = Object.values(bindings.noteHooks).map((binding) => binding.hookToken);
  for (const hook of Object.values(bindings.noteHooks)) {
    const workflow = bindings.workflows[hook.productRunId];
    if (workflow?.runnerFamily !== NOTE_CAPTURE_RUNNER_FAMILY) {
      throw new RuntimeBindingError("Note Hook映射缺少对应Note Workflow映射");
    }
  }
  for (const outboxId of Object.keys(bindings.memoryImportStartIntents) as OutboxEntryId[]) {
    if (bindings.memoryImportWorkflows[outboxId] !== undefined) {
      throw new RuntimeBindingError("同一Import Outbox不能同时存在start意图与Workflow映射");
    }
  }
  for (const outboxId of Object.keys(bindings.memoryWriteStartIntents) as OutboxEntryId[]) {
    if (bindings.memoryWriteWorkflows[outboxId] !== undefined) {
      throw new RuntimeBindingError("同一Memory Write Outbox不能同时存在start意图与Workflow映射");
    }
  }
  for (const projectCandidateId of Object.keys(
    bindings.projectIntakeStartIntents,
  ) as ProjectCandidateId[]) {
    if (bindings.projectIntakeWorkflows[projectCandidateId] !== undefined) {
      throw new RuntimeBindingError("同一Project Candidate不能同时存在start意图与Workflow映射");
    }
  }
  const projectWorkflowRunIds = Object.values(bindings.projectIntakeWorkflows).map(
    (binding) => binding.workflowRunId,
  );
  const everyWorkflowRunId = [...allWorkflowRunIds, ...projectWorkflowRunIds];
  if (new Set(everyWorkflowRunId).size !== everyWorkflowRunId.length) {
    throw new RuntimeBindingError("多个产品操作不能共享同一Workflow Run映射");
  }
  const projectHookTokens = Object.values(bindings.projectIntakeWorkflows).map(
    (binding) => binding.hookToken,
  );
  const everyHookToken = [...hookTokens, ...noteHookTokens, ...projectHookTokens];
  if (new Set(everyHookToken).size !== everyHookToken.length) {
    throw new RuntimeBindingError("多个产品操作不能共享同一Hook Token");
  }
}

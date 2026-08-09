import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  WORKFLOW_KERNEL_LIMITS,
  WORKFLOW_NODE_TYPES,
  type WorkflowDiagnostic,
  type WorkflowElement,
  type WorkflowSequence,
} from "@chat/domain";

const definitionNodeIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const outcomeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);
// Node自己的strict parser会在Catalog阶段继续收窄；这里只限制key和JSON边界形状。
const configSchema = z.record(z.string().min(1).max(64), z.unknown());

const taskSchema = z.strictObject({
  kind: z.literal("task"),
  definitionNodeId: definitionNodeIdSchema,
  nodeType: z.enum(WORKFLOW_NODE_TYPES),
  schemaVersion: z.number().int().min(1).max(32),
  config: configSchema,
  defaultActivation: z.enum(["enabled", "skipped"]).optional(),
});

const compositeSchema = z.strictObject({
  kind: z.literal("composite"),
  definitionNodeId: definitionNodeIdSchema,
  nodeType: z.enum(WORKFLOW_NODE_TYPES),
  schemaVersion: z.number().int().min(1).max(32),
  config: configSchema,
  defaultActivation: z.enum(["enabled", "skipped"]).optional(),
});

/** 手写递归类型 + z.lazy边界，避免z.infer把递归类型无限展开。 */
let workflowElementBoundarySchema: z.ZodType<WorkflowElement>;

export const workflowSequenceBoundarySchema: z.ZodType<WorkflowSequence> = z.lazy(() =>
  z.strictObject({
    kind: z.literal("sequence"),
    elements: z
      .array(workflowElementBoundarySchema)
      .max(WORKFLOW_KERNEL_LIMITS.structure.maxNodes * 2),
  }),
);

const choiceSchema = z.strictObject({
  kind: z.literal("choice"),
  fromDefinitionNodeId: definitionNodeIdSchema,
  branches: z
    .array(
      z.strictObject({
        outcome: outcomeSchema,
        body: workflowSequenceBoundarySchema,
      }),
    )
    .min(1)
    .max(WORKFLOW_KERNEL_LIMITS.structure.maxBranches),
});

const boundedLoopSchema = z.strictObject({
  kind: z.literal("bounded_loop"),
  body: workflowSequenceBoundarySchema,
  outcomeFromDefinitionNodeId: definitionNodeIdSchema,
  continueOutcomes: z.array(outcomeSchema).min(1).max(16),
  exitOutcomes: z.array(outcomeSchema).min(1).max(16),
  // 业务limit仍由Domain给稳定诊断；Schema只排除非整数和荒谬输入。
  maxIterations: z.number().int().min(1).max(1_000),
  exceededPolicy: z.enum(["fail", "request_human"]),
});

workflowElementBoundarySchema = z.lazy(() =>
  z.union([
    workflowSequenceBoundarySchema,
    taskSchema,
    choiceSchema,
    boundedLoopSchema,
    compositeSchema,
  ]),
);

export interface WorkflowDefinitionRevisionInput {
  readonly schemaVersion: "workflow-definition-revision-input.v1";
  readonly workflowDefinitionRevisionId: string;
  readonly definitionRevision: number;
  readonly blueprintKey: "planning" | "note";
  readonly blueprintVersion: number;
  readonly semanticRoot: WorkflowSequence;
  readonly expectedSha256?: string | undefined;
}

export const workflowDefinitionRevisionInputSchema: z.ZodType<WorkflowDefinitionRevisionInput> =
  z.strictObject({
    schemaVersion: z.literal("workflow-definition-revision-input.v1"),
    workflowDefinitionRevisionId: z.string().regex(/^wfr_[A-Za-z0-9]+$/),
    definitionRevision: z.number().int().min(1),
    blueprintKey: z.enum(["planning", "note"]),
    blueprintVersion: z.number().int().min(1).max(32),
    semanticRoot: workflowSequenceBoundarySchema,
    expectedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  });

export type WorkflowResourceKind = "memory" | "project" | "rule" | "skill";

export interface WorkflowFrozenResource {
  readonly resourceKind: WorkflowResourceKind;
  readonly resourceId: string;
  readonly revision: number;
  readonly sha256: string;
  readonly status: "active" | "archived";
  readonly allowedPrincipalIds: readonly string[];
}

export const workflowFrozenResourceSchema: z.ZodType<WorkflowFrozenResource> = z.strictObject({
  resourceKind: z.enum(["memory", "project", "rule", "skill"]),
  resourceId: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/),
  revision: z.number().int().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["active", "archived"]),
  allowedPrincipalIds: z.array(z.string().regex(/^usr_[A-Za-z0-9]+$/)).max(100),
});

export interface WorkflowPrincipalSnapshot {
  readonly principalId: string;
  readonly capabilities: readonly string[];
}

export const workflowPrincipalSnapshotSchema: z.ZodType<WorkflowPrincipalSnapshot> = z.strictObject(
  {
    principalId: z.string().regex(/^usr_[A-Za-z0-9]+$/),
    capabilities: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z][a-z0-9_.-]*$/),
      )
      .max(64),
  },
);

const selectedResourceRefSchema = z.strictObject({
  resourceId: z
    .string()
    .min(3)
    .max(128)
    .regex(/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/),
  expectedRevision: z.number().int().min(1),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const nodeEnabledOverrideSchema = z.strictObject({
  kind: z.literal("node_enabled"),
  definitionNodeId: definitionNodeIdSchema,
  enabled: z.boolean(),
});

const resourceSelectionOverrideSchema = z.strictObject({
  kind: z.literal("resource_selection"),
  definitionNodeId: definitionNodeIdSchema,
  resourceKind: z.enum(["memory", "project", "rule", "skill"]),
  required: z.boolean(),
  selections: z.array(selectedResourceRefSchema).max(32),
});

const reviewModeOverrideSchema = z.strictObject({
  kind: z.literal("review_mode"),
  definitionNodeId: definitionNodeIdSchema,
  reviewMode: z.enum(["manual", "auto_continue_if_policy_allows", "always_auto"]),
});

export const workflowRunOverrideSchema = z.discriminatedUnion("kind", [
  nodeEnabledOverrideSchema,
  resourceSelectionOverrideSchema,
  reviewModeOverrideSchema,
]);
export type WorkflowRunOverride = z.infer<typeof workflowRunOverrideSchema>;

export interface WorkflowRunConfiguration {
  readonly schemaVersion: "workflow-run-configuration.v1";
  readonly overrides: readonly WorkflowRunOverride[];
}

export const workflowRunConfigurationSchema: z.ZodType<WorkflowRunConfiguration> = z.strictObject({
  schemaVersion: z.literal("workflow-run-configuration.v1"),
  overrides: z.array(workflowRunOverrideSchema).max(64),
});

export type ParsedWorkflowDefinition =
  | { readonly success: true; readonly definition: WorkflowDefinitionRevisionInput }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

/**
 * DTO字节与原始对象深度先于递归Zod解析。即使传入深层恶意对象，也只返回稳定诊断，
 * 不让RangeError或Zod内部路径泄漏成500。
 */
export function parseWorkflowDefinitionRevision(input: unknown): ParsedWorkflowDefinition {
  const bytes = safeJsonByteLength(input);
  if (bytes === undefined || bytes > WORKFLOW_KERNEL_LIMITS.request.maxDefinitionBytes) {
    return {
      success: false,
      diagnostics: [
        {
          family: "limit_exceeded",
          code: "definition.request_bytes_exceeded",
          path: "$",
          params: {
            limit: WORKFLOW_KERNEL_LIMITS.request.maxDefinitionBytes,
            ...(bytes !== undefined ? { actual: bytes } : {}),
          },
        },
      ],
    };
  }
  if (rawObjectDepthExceeds(input, WORKFLOW_KERNEL_LIMITS.structure.maxDepth * 4)) {
    return {
      success: false,
      diagnostics: [
        {
          family: "limit_exceeded",
          code: "definition.raw_depth_exceeded",
          path: "$",
          params: { limit: WORKFLOW_KERNEL_LIMITS.structure.maxDepth },
        },
      ],
    };
  }
  try {
    const parsed = workflowDefinitionRevisionInputSchema.safeParse(input);
    if (parsed.success) return { success: true, definition: parsed.data };
    return {
      success: false,
      diagnostics: parsed.error.issues.slice(0, 32).map((issue) => ({
        family: "definition_invalid",
        code: `definition.schema.${issue.code}`,
        path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
        params: {},
      })),
    };
  } catch {
    return {
      success: false,
      diagnostics: [
        {
          family: "definition_invalid",
          code: "definition.schema_parse_failed",
          path: "$",
          params: {},
        },
      ],
    };
  }
}

function safeJsonByteLength(input: unknown): number | undefined {
  try {
    const json = JSON.stringify(input);
    return json === undefined ? undefined : Buffer.byteLength(json, "utf8");
  } catch {
    return undefined;
  }
}

function rawObjectDepthExceeds(input: unknown, maximum: number): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: input, depth: 1 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > maximum) return true;
    if (frame.value === null || typeof frame.value !== "object") continue;
    if (seen.has(frame.value)) return true;
    seen.add(frame.value);
    for (const value of Object.values(frame.value)) {
      if (value !== null && typeof value === "object") {
        stack.push({ value, depth: frame.depth + 1 });
      }
    }
  }
  return false;
}

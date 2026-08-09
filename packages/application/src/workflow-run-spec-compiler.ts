import { z } from "zod";
import {
  WORKFLOW_KERNEL_LIMITS,
  hashCanonical,
  sortWorkflowDiagnostics,
  validateWorkflowStructure,
  type WorkflowDiagnostic,
  type WorkflowNodeTypeKey,
  type WorkflowReviewMode,
  type WorkflowSequence,
} from "@chat/domain";
import {
  DEFAULT_WORKFLOW_BLUEPRINTS,
  type WorkflowBlueprint,
  type WorkflowBlueprintRegistry,
  validateDefinitionAgainstBlueprint,
} from "./workflow-blueprints.js";
import {
  parseWorkflowDefinitionRevision,
  workflowFrozenResourceSchema,
  workflowPrincipalSnapshotSchema,
  workflowRunConfigurationSchema,
  workflowSequenceBoundarySchema,
  type WorkflowDefinitionRevisionInput,
  type WorkflowFrozenResource,
  type WorkflowPrincipalSnapshot,
  type WorkflowResourceKind,
  type WorkflowRunConfiguration,
  type WorkflowRunOverride,
} from "./workflow-definition-schema.js";
import {
  DEFAULT_NODE_CATALOG,
  nodeExecutorKey,
  type NodeCatalog,
} from "./workflow-node-catalog.js";
import { normalizeWorkflowDefinition } from "./workflow-definition-normalize.js";

const executorManifestEntrySchema = z.strictObject({
  nodeType: z.enum([
    "context.memory",
    "context.project",
    "policy.rules",
    "capability.skills",
    "agent.research",
    "agent.plan",
    "human.plan_review",
    "execute.plan",
    "result.validate",
    "product.commit",
    "note.extract",
    "note.classify",
    "human.note_review",
    "note.commit",
  ]),
  schemaVersion: z.number().int().min(1).max(32),
  executorVersion: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
});
export type WorkflowExecutorManifestEntry = z.infer<typeof executorManifestEntrySchema>;

const runnerEvidenceSchema = z.strictObject({
  runnerFamily: z.literal("definition-kernel-lab.v1"),
  runnerBundleVersion: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/),
});
export type WorkflowRunnerEvidence = z.infer<typeof runnerEvidenceSchema>;

const resolvedResourceBase = {
  definitionNodeId: z.string(),
  resourceKind: z.enum(["memory", "project", "rule", "skill"]),
} as const;
const frozenSelectedResourceFields = {
  resourceId: z.string(),
  expectedRevision: z.number().int().min(1),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
} as const;
const resolvedResourceSchema = z.union([
  z.strictObject({
    ...resolvedResourceBase,
    ...frozenSelectedResourceFields,
    resolution: z.literal("included"),
  }),
  z.strictObject({
    ...resolvedResourceBase,
    ...frozenSelectedResourceFields,
    resolution: z.literal("excluded"),
    exclusionReason: z.enum([
      "not_found",
      "archived",
      "forbidden",
      "revision_stale",
      "hash_mismatch",
    ]),
  }),
  z.strictObject({
    ...resolvedResourceBase,
    resolution: z.literal("excluded"),
    exclusionReason: z.literal("not_selected"),
  }),
]);
export type WorkflowResolvedResource = z.infer<typeof resolvedResourceSchema>;

const nodeResolutionSchema = z.strictObject({
  definitionNodeId: z.string(),
  nodeType: executorManifestEntrySchema.shape.nodeType,
  schemaVersion: z.number().int().min(1),
  config: z.record(z.string(), z.unknown()),
  activation: z.enum(["enabled", "skipped"]),
  skipOutcome: z.string().optional(),
});
export type WorkflowNodeResolution = z.infer<typeof nodeResolutionSchema>;

const reviewResolutionSchema = z.strictObject({
  definitionNodeId: z.string(),
  mode: z.enum(["manual", "auto_continue_if_policy_allows", "always_auto"]),
  actor: z.enum(["user", "system_policy"]),
  policyRef: z
    .strictObject({
      resourceId: z.string(),
      revision: z.number().int().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export type WorkflowReviewResolution = z.infer<typeof reviewResolutionSchema>;

const kernelLimitsSchema = z.strictObject({
  request: z.strictObject({ maxDefinitionBytes: z.number().int().positive() }),
  structure: z.strictObject({
    maxDepth: z.number().int().positive(),
    maxNodes: z.number().int().positive(),
    maxBranches: z.number().int().positive(),
    maxLoops: z.number().int().positive(),
    maxNestedLoops: z.number().int().positive(),
    maxLoopIterations: z.number().int().positive(),
  }),
  runtime: z.strictObject({
    maxNodeExecutions: z.number().int().positive(),
    maxCompositeChildren: z.number().int().positive(),
    maxWaits: z.number().int().positive(),
  }),
  projection: z.strictObject({
    maxManifestSlots: z.number().int().positive(),
    maxPreviewBytes: z.number().int().positive(),
  }),
});

export const workflowRunSpecSchema = z.strictObject({
  schemaVersion: z.literal("workflow-run-spec.v1"),
  workflowRunSpecId: z.string().regex(/^wrs_[A-Za-z0-9]+$/),
  productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
  definitionRef: z.strictObject({
    workflowDefinitionRevisionId: z.string().regex(/^wfr_[A-Za-z0-9]+$/),
    definitionRevision: z.number().int().min(1),
    definitionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    blueprintKey: z.enum(["planning", "note"]),
    blueprintVersion: z.number().int().min(1),
  }),
  runner: runnerEvidenceSchema,
  semanticRoot: workflowSequenceBoundarySchema,
  nodeResolutions: z.array(nodeResolutionSchema).max(WORKFLOW_KERNEL_LIMITS.structure.maxNodes),
  resourceResolutions: z.array(resolvedResourceSchema).max(128),
  reviewResolutions: z.array(reviewResolutionSchema).max(16),
  limits: kernelLimitsSchema,
  executorManifest: z.array(executorManifestEntrySchema).max(64),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});
export type WorkflowRunSpec = z.infer<typeof workflowRunSpecSchema>;

const policyEvidenceSchema = z.strictObject({
  resourceId: z.string().min(3).max(128),
  expectedRevision: z.number().int().min(1),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type WorkflowPolicyEvidence = z.infer<typeof policyEvidenceSchema>;

export interface CompileWorkflowRunSpecInput {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
  readonly createdAt: string;
  readonly definition: unknown;
  readonly runConfiguration: unknown;
  readonly principal: unknown;
  readonly availableResources: readonly unknown[];
  readonly executorManifest: readonly unknown[];
  readonly runner: unknown;
  /** 服务端策略解析结果；浏览器不能自行提交该字段。 */
  readonly autoContinuePolicy?: unknown;
}

export type CompileWorkflowRunSpecResult =
  | { readonly success: true; readonly runSpec: WorkflowRunSpec }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

interface CompilerContext {
  readonly definition: WorkflowDefinitionRevisionInput;
  readonly configuration: WorkflowRunConfiguration;
  readonly principal: WorkflowPrincipalSnapshot;
  readonly resources: readonly WorkflowFrozenResource[];
  readonly executorManifest: readonly WorkflowExecutorManifestEntry[];
  readonly runner: WorkflowRunnerEvidence;
  readonly policyEvidence?: WorkflowPolicyEvidence | undefined;
  readonly blueprint: WorkflowBlueprint;
}

/**
 * 纯Compiler严格按parse→structure→catalog→policy→resource→normalize→hash→schema推进。
 * 失败返回有限诊断，不把用户正文或任意Error.message当作业务结果。
 */
export function compileWorkflowRunSpec(
  input: CompileWorkflowRunSpecInput,
  dependencies: {
    readonly catalog?: NodeCatalog;
    readonly blueprints?: WorkflowBlueprintRegistry;
  } = {},
): CompileWorkflowRunSpecResult {
  const catalog = dependencies.catalog ?? DEFAULT_NODE_CATALOG;
  const blueprints = dependencies.blueprints ?? DEFAULT_WORKFLOW_BLUEPRINTS;
  const parsedDefinition = parseWorkflowDefinitionRevision(input.definition);
  if (!parsedDefinition.success) return parsedDefinition;

  const boundary = parseCompilerBoundaries(input, parsedDefinition.definition, blueprints);
  if (!boundary.success) return boundary;
  const context = boundary.context;

  const structure = validateWorkflowStructure(context.definition.semanticRoot, {
    outcomesFor: (nodeType, schemaVersion) => catalog.get(nodeType, schemaVersion)?.outcomes,
  });
  const blueprintDiagnostics = validateDefinitionAgainstBlueprint(
    context.definition.semanticRoot,
    context.blueprint,
    catalog,
  );
  if (structure.facts.maximumNodeExecutions > WORKFLOW_KERNEL_LIMITS.runtime.maxNodeExecutions) {
    return {
      success: false,
      diagnostics: sortWorkflowDiagnostics([
        ...structure.diagnostics,
        ...blueprintDiagnostics,
        {
          family: "limit_exceeded",
          code: "definition.maximum_execution_budget_exceeded",
          path: "$",
          params: {
            actual: structure.facts.maximumNodeExecutions,
            limit: WORKFLOW_KERNEL_LIMITS.runtime.maxNodeExecutions,
          },
        },
      ]),
    };
  }
  if (structure.diagnostics.length > 0 || blueprintDiagnostics.length > 0) {
    return {
      success: false,
      diagnostics: sortWorkflowDiagnostics([...structure.diagnostics, ...blueprintDiagnostics]),
    };
  }

  const normalized = normalizeWorkflowDefinition(context.definition.semanticRoot, catalog);
  if (!normalized.success) return normalized;
  if (
    context.definition.expectedSha256 !== undefined &&
    context.definition.expectedSha256 !== normalized.normalized.definitionSha256
  ) {
    return {
      success: false,
      diagnostics: [
        {
          family: "resource_stale",
          code: "definition.hash_stale",
          path: "$.definition.expectedSha256",
          params: {},
        },
      ],
    };
  }

  const nodeIndex = indexNodes(normalized.normalized.semanticRoot);
  const policy = resolvePolicyAndNodes(context, nodeIndex, catalog);
  if (policy.diagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(policy.diagnostics) };
  }
  const resources = resolveResources(context, nodeIndex);
  if (resources.diagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(resources.diagnostics) };
  }
  const manifestDiagnostics = validateExecutorManifest(context, nodeIndex);
  if (manifestDiagnostics.length > 0) {
    return { success: false, diagnostics: sortWorkflowDiagnostics(manifestDiagnostics) };
  }

  const definitionRef = {
    workflowDefinitionRevisionId: context.definition.workflowDefinitionRevisionId,
    definitionRevision: context.definition.definitionRevision,
    definitionSha256: normalized.normalized.definitionSha256,
    blueprintKey: context.definition.blueprintKey,
    blueprintVersion: context.definition.blueprintVersion,
  } as const;
  const executionPayload = {
    definitionRef,
    runner: context.runner,
    semanticRoot: normalized.normalized.semanticRoot,
    nodeResolutions: policy.nodeResolutions,
    resourceResolutions: resources.resolutions,
    reviewResolutions: policy.reviewResolutions,
    limits: WORKFLOW_KERNEL_LIMITS,
    executorManifest: [...context.executorManifest].sort((left, right) =>
      nodeExecutorKey(left.nodeType, left.schemaVersion).localeCompare(
        nodeExecutorKey(right.nodeType, right.schemaVersion),
      ),
    ),
  };
  const candidate = {
    schemaVersion: "workflow-run-spec.v1" as const,
    workflowRunSpecId: input.workflowRunSpecId,
    productRunId: input.productRunId,
    ...executionPayload,
    sha256: hashCanonical("workflow-run-spec.v1", executionPayload),
    createdAt: input.createdAt,
  };
  const parsedRunSpec = workflowRunSpecSchema.safeParse(candidate);
  if (!parsedRunSpec.success) {
    return {
      success: false,
      diagnostics: parsedRunSpec.error.issues.slice(0, 32).map((issue) => ({
        family: "definition_invalid",
        code: `run_spec.schema.${issue.code}`,
        path: issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`,
        params: {},
      })),
    };
  }
  return { success: true, runSpec: parsedRunSpec.data };
}

export function validateWorkflowRunSpecIntegrity(
  input: unknown,
):
  | { readonly success: true; readonly runSpec: WorkflowRunSpec }
  | { readonly success: false; readonly diagnostics: readonly WorkflowDiagnostic[] } {
  const parsed = workflowRunSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      diagnostics: [
        { family: "definition_invalid", code: "run_spec.schema_invalid", path: "$", params: {} },
      ],
    };
  }
  const {
    schemaVersion: _schema,
    workflowRunSpecId: _id,
    productRunId: _run,
    sha256,
    createdAt: _at,
    ...payload
  } = parsed.data;
  const expected = hashCanonical("workflow-run-spec.v1", payload);
  if (expected !== sha256) {
    return {
      success: false,
      diagnostics: [
        { family: "resource_stale", code: "run_spec.hash_mismatch", path: "$.sha256", params: {} },
      ],
    };
  }
  return { success: true, runSpec: parsed.data };
}

/** Run创建事务在提交前调用，拒绝Compiler读取后发生的资源revision/hash漂移。 */
export function validateRunSpecResourcesCurrent(
  runSpec: WorkflowRunSpec,
  currentResources: readonly WorkflowFrozenResource[],
): readonly WorkflowDiagnostic[] {
  const current = new Map(
    currentResources.map((resource) => [
      resourceKey(resource.resourceKind, resource.resourceId),
      resource,
    ]),
  );
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const resolution of runSpec.resourceResolutions) {
    if (resolution.resolution !== "included") continue;
    const resource = current.get(resourceKey(resolution.resourceKind, resolution.resourceId));
    if (
      resource === undefined ||
      resource.status !== "active" ||
      resource.revision !== resolution.expectedRevision ||
      resource.sha256 !== resolution.expectedSha256
    ) {
      diagnostics.push({
        family: "resource_stale",
        code: "resource.changed_before_run_create",
        path: `$.resourceResolutions.${resolution.definitionNodeId}`,
        params: { resourceKind: resolution.resourceKind, resourceId: resolution.resourceId },
      });
    }
  }
  return sortWorkflowDiagnostics(diagnostics);
}

function parseCompilerBoundaries(
  input: CompileWorkflowRunSpecInput,
  definition: WorkflowDefinitionRevisionInput,
  blueprints: WorkflowBlueprintRegistry,
):
  | { readonly success: true; readonly context: CompilerContext }
  | {
      readonly success: false;
      readonly diagnostics: readonly WorkflowDiagnostic[];
    } {
  const configuration = workflowRunConfigurationSchema.safeParse(input.runConfiguration);
  const principal = workflowPrincipalSnapshotSchema.safeParse(input.principal);
  const resources = z
    .array(workflowFrozenResourceSchema)
    .max(256)
    .safeParse(input.availableResources);
  const manifest = z.array(executorManifestEntrySchema).max(64).safeParse(input.executorManifest);
  const runner = runnerEvidenceSchema.safeParse(input.runner);
  const policyEvidence =
    input.autoContinuePolicy === undefined
      ? { success: true as const, data: undefined }
      : policyEvidenceSchema.safeParse(input.autoContinuePolicy);
  const blueprint = blueprints.get(definition.blueprintKey, definition.blueprintVersion);
  const invalid: string[] = [];
  if (!configuration.success) invalid.push("run_configuration");
  if (!principal.success) invalid.push("principal");
  if (!resources.success) invalid.push("resources");
  if (!manifest.success) invalid.push("executor_manifest");
  if (!runner.success) invalid.push("runner");
  if (!policyEvidence.success) invalid.push("auto_continue_policy");
  if (blueprint === undefined) invalid.push("blueprint");
  if (
    invalid.length > 0 ||
    !configuration.success ||
    !principal.success ||
    !resources.success ||
    !manifest.success ||
    !runner.success ||
    !policyEvidence.success ||
    blueprint === undefined
  ) {
    return {
      success: false,
      diagnostics: invalid.sort().map((boundary) => ({
        family: "definition_invalid",
        code: "compiler.boundary_invalid",
        path: `$.${boundary}`,
        params: { boundary },
      })),
    };
  }
  return {
    success: true,
    context: {
      definition,
      configuration: configuration.data,
      principal: principal.data,
      resources: resources.data,
      executorManifest: manifest.data,
      runner: runner.data,
      policyEvidence: policyEvidence.data,
      blueprint,
    },
  };
}

interface IndexedNode {
  readonly definitionNodeId: string;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly defaultActivation: "enabled" | "skipped";
  readonly path: string;
}

function indexNodes(root: WorkflowSequence): ReadonlyMap<string, IndexedNode> {
  const result = new Map<string, IndexedNode>();
  const stack: {
    readonly element: WorkflowSequence["elements"][number] | WorkflowSequence;
    readonly path: string;
  }[] = [{ element: root, path: "$" }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const element = frame.element;
    if (element.kind === "task" || element.kind === "composite") {
      result.set(element.definitionNodeId, {
        definitionNodeId: element.definitionNodeId,
        nodeType: element.nodeType,
        schemaVersion: element.schemaVersion,
        config: element.config,
        defaultActivation: element.defaultActivation ?? "enabled",
        path: frame.path,
      });
    } else if (element.kind === "sequence") {
      for (let index = element.elements.length - 1; index >= 0; index -= 1) {
        const child = element.elements[index];
        if (child !== undefined)
          stack.push({ element: child, path: `${frame.path}.elements[${String(index)}]` });
      }
    } else if (element.kind === "choice") {
      for (let index = element.branches.length - 1; index >= 0; index -= 1) {
        const branch = element.branches[index];
        if (branch !== undefined)
          stack.push({
            element: branch.body,
            path: `${frame.path}.branches[${String(index)}].body`,
          });
      }
    } else {
      stack.push({ element: element.body, path: `${frame.path}.body` });
    }
  }
  return result;
}

function resolvePolicyAndNodes(
  context: CompilerContext,
  nodes: ReadonlyMap<string, IndexedNode>,
  catalog: NodeCatalog,
): {
  readonly nodeResolutions: readonly WorkflowNodeResolution[];
  readonly reviewResolutions: readonly WorkflowReviewResolution[];
  readonly diagnostics: readonly WorkflowDiagnostic[];
} {
  const diagnostics: WorkflowDiagnostic[] = [];
  const overrideKeys = new Set<string>();
  const enabled = new Map<string, boolean>();
  const reviewModes = new Map<string, WorkflowReviewMode>();
  for (const override of context.configuration.overrides) {
    const key = overrideIdentity(override);
    if (overrideKeys.has(key)) {
      diagnostics.push(
        policyDiagnostic(
          "run_configuration.duplicate_override",
          `$.overrides.${override.definitionNodeId}`,
          { kind: override.kind },
        ),
      );
      continue;
    }
    overrideKeys.add(key);
    const node = nodes.get(override.definitionNodeId);
    if (node === undefined) {
      diagnostics.push(
        policyDiagnostic(
          "run_configuration.unknown_node",
          `$.overrides.${override.definitionNodeId}`,
          {},
        ),
      );
      continue;
    }
    const allowed =
      context.blueprint.perRunOverrides.find((rule) => rule.nodeType === node.nodeType)?.fields ??
      [];
    const field =
      override.kind === "node_enabled"
        ? "enabled"
        : override.kind === "review_mode"
          ? "reviewMode"
          : "selection";
    if (!allowed.includes(field)) {
      diagnostics.push(
        policyDiagnostic(
          "run_configuration.override_not_allowed",
          `$.overrides.${override.definitionNodeId}`,
          { field },
        ),
      );
      continue;
    }
    if (override.kind === "node_enabled") enabled.set(override.definitionNodeId, override.enabled);
    if (override.kind === "review_mode")
      reviewModes.set(override.definitionNodeId, override.reviewMode);
  }

  const nodeResolutions: WorkflowNodeResolution[] = [];
  const reviewResolutions: WorkflowReviewResolution[] = [];
  for (const node of [...nodes.values()].sort((left, right) =>
    left.definitionNodeId.localeCompare(right.definitionNodeId),
  )) {
    const descriptor = catalog.get(node.nodeType, node.schemaVersion);
    if (descriptor === undefined) continue;
    const requestedEnabled = enabled.get(node.definitionNodeId);
    const activation =
      requestedEnabled === undefined
        ? node.defaultActivation
        : requestedEnabled
          ? "enabled"
          : "skipped";
    let skipOutcome: string | undefined;
    if (activation === "skipped") {
      if (
        !context.blueprint.optionalNodeTypes.includes(node.nodeType) ||
        descriptor.skipPolicy.kind === "never"
      ) {
        diagnostics.push(
          policyDiagnostic("policy.skip_denied", node.path, { nodeType: node.nodeType }),
        );
      } else if (descriptor.skipPolicy.kind === "allowed_with_default_outcome") {
        skipOutcome = descriptor.skipPolicy.defaultOutcome;
      } else {
        diagnostics.push(
          policyDiagnostic("policy.explicit_skip_value_not_supported", node.path, {
            nodeType: node.nodeType,
          }),
        );
      }
    }
    nodeResolutions.push({
      definitionNodeId: node.definitionNodeId,
      nodeType: node.nodeType,
      schemaVersion: node.schemaVersion,
      config: node.config,
      activation,
      ...(skipOutcome !== undefined ? { skipOutcome } : {}),
    });

    if (descriptor.executorKind === "human_review") {
      const configuredMode =
        typeof node.config.reviewMode === "string"
          ? (node.config.reviewMode as WorkflowReviewMode)
          : "manual";
      const mode = reviewModes.get(node.definitionNodeId) ?? configuredMode;
      if (
        mode !== "manual" &&
        context.blueprint.mandatoryManualReviewTypes.includes(node.nodeType)
      ) {
        diagnostics.push(
          policyDiagnostic("policy.mandatory_manual_review", node.path, {
            nodeType: node.nodeType,
          }),
        );
      }
      if (mode === "manual") {
        reviewResolutions.push({ definitionNodeId: node.definitionNodeId, mode, actor: "user" });
      } else {
        const policy = resolveAutoPolicy(context, mode, node.path, diagnostics);
        if (policy !== undefined) {
          reviewResolutions.push({
            definitionNodeId: node.definitionNodeId,
            mode,
            actor: "system_policy",
            policyRef: policy,
          });
        }
      }
    }
  }
  return { nodeResolutions, reviewResolutions, diagnostics };
}

function resolveAutoPolicy(
  context: CompilerContext,
  mode: Exclude<WorkflowReviewMode, "manual">,
  path: string,
  diagnostics: WorkflowDiagnostic[],
): { readonly resourceId: string; readonly revision: number; readonly sha256: string } | undefined {
  const requiredCapability =
    mode === "always_auto" ? "workflow.review.always_auto" : "workflow.review.auto";
  if (
    !context.principal.capabilities.includes(requiredCapability) ||
    context.policyEvidence === undefined
  ) {
    diagnostics.push(policyDiagnostic("policy.auto_continue_denied", path, { mode }));
    return undefined;
  }
  const resource = context.resources.find(
    (candidate) =>
      candidate.resourceKind === "rule" &&
      candidate.resourceId === context.policyEvidence?.resourceId,
  );
  if (
    resource === undefined ||
    resource.status !== "active" ||
    !resource.allowedPrincipalIds.includes(context.principal.principalId) ||
    resource.revision !== context.policyEvidence.expectedRevision ||
    resource.sha256 !== context.policyEvidence.expectedSha256
  ) {
    diagnostics.push({
      family: "resource_stale",
      code: "policy.auto_continue_evidence_stale",
      path,
      params: {},
    });
    return undefined;
  }
  return { resourceId: resource.resourceId, revision: resource.revision, sha256: resource.sha256 };
}

function resolveResources(
  context: CompilerContext,
  nodes: ReadonlyMap<string, IndexedNode>,
): {
  readonly resolutions: readonly WorkflowResolvedResource[];
  readonly diagnostics: readonly WorkflowDiagnostic[];
} {
  const diagnostics: WorkflowDiagnostic[] = [];
  const resolutions: WorkflowResolvedResource[] = [];
  const selectionOverrides = context.configuration.overrides.filter(
    (override): override is Extract<WorkflowRunOverride, { kind: "resource_selection" }> =>
      override.kind === "resource_selection",
  );
  for (const node of nodes.values()) {
    const expectedKind = resourceKindForNode(node.nodeType);
    if (expectedKind === undefined) continue;
    const override = selectionOverrides.find(
      (candidate) => candidate.definitionNodeId === node.definitionNodeId,
    );
    const configRequired = node.config.required === true;
    const required = configRequired || override?.required === true;
    const selectedIds = new Set<string>();
    if (override === undefined || override.selections.length === 0) {
      if (required) {
        diagnostics.push({
          family: "resource_stale",
          code: "resource.required_selection_missing",
          path: node.path,
          params: { resourceKind: expectedKind },
        });
      } else {
        resolutions.push({
          definitionNodeId: node.definitionNodeId,
          resourceKind: expectedKind,
          resolution: "excluded",
          exclusionReason: "not_selected",
        });
      }
      continue;
    }
    if (expectedKind !== override.resourceKind) {
      diagnostics.push(
        policyDiagnostic("resource.kind_not_allowed_for_node", node.path, {
          resourceKind: override.resourceKind,
        }),
      );
      continue;
    }
    for (const selected of override.selections) {
      if (selectedIds.has(selected.resourceId)) {
        diagnostics.push(
          policyDiagnostic("resource.duplicate_selection", node.path, {
            resourceId: selected.resourceId,
          }),
        );
        continue;
      }
      selectedIds.add(selected.resourceId);
      if (!selected.resourceId.startsWith(`${resourcePrefix(override.resourceKind)}_`)) {
        diagnostics.push(
          policyDiagnostic("resource.id_prefix_invalid", node.path, {
            resourceKind: override.resourceKind,
          }),
        );
        continue;
      }
      const resource = context.resources.find(
        (candidate) =>
          candidate.resourceKind === override.resourceKind &&
          candidate.resourceId === selected.resourceId,
      );
      const exclusionReason =
        resource === undefined
          ? "not_found"
          : resource.status === "archived"
            ? "archived"
            : !resource.allowedPrincipalIds.includes(context.principal.principalId)
              ? "forbidden"
              : resource.revision !== selected.expectedRevision
                ? "revision_stale"
                : resource.sha256 !== selected.expectedSha256
                  ? "hash_mismatch"
                  : undefined;
      if (exclusionReason !== undefined) {
        if (required) {
          diagnostics.push({
            family: "resource_stale",
            code: `resource.${exclusionReason}`,
            path: node.path,
            params: { resourceKind: override.resourceKind, resourceId: selected.resourceId },
          });
        } else {
          resolutions.push({
            definitionNodeId: node.definitionNodeId,
            resourceKind: override.resourceKind,
            resourceId: selected.resourceId,
            expectedRevision: selected.expectedRevision,
            expectedSha256: selected.expectedSha256,
            resolution: "excluded",
            exclusionReason,
          });
        }
      } else {
        resolutions.push({
          definitionNodeId: node.definitionNodeId,
          resourceKind: override.resourceKind,
          resourceId: selected.resourceId,
          expectedRevision: selected.expectedRevision,
          expectedSha256: selected.expectedSha256,
          resolution: "included",
        });
      }
    }
  }
  return {
    resolutions: resolutions.sort((left, right) => {
      const leftId = "resourceId" in left ? left.resourceId : "";
      const rightId = "resourceId" in right ? right.resourceId : "";
      return `${left.definitionNodeId}\0${left.resourceKind}\0${leftId}`.localeCompare(
        `${right.definitionNodeId}\0${right.resourceKind}\0${rightId}`,
      );
    }),
    diagnostics,
  };
}

function validateExecutorManifest(
  context: CompilerContext,
  nodes: ReadonlyMap<string, IndexedNode>,
): readonly WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const manifest = new Map<string, WorkflowExecutorManifestEntry>();
  for (const entry of context.executorManifest) {
    const key = nodeExecutorKey(entry.nodeType, entry.schemaVersion);
    if (manifest.has(key))
      diagnostics.push({
        family: "definition_invalid",
        code: "executor_manifest.duplicate_key",
        path: "$.executorManifest",
        params: { key },
      });
    manifest.set(key, entry);
  }
  for (const node of nodes.values()) {
    const key = nodeExecutorKey(node.nodeType, node.schemaVersion);
    if (!manifest.has(key))
      diagnostics.push({
        family: "definition_invalid",
        code: "executor_manifest.missing_executor",
        path: node.path,
        params: { key },
      });
  }
  return diagnostics;
}

function overrideIdentity(override: WorkflowRunOverride): string {
  return `${override.kind}\0${override.definitionNodeId}${override.kind === "resource_selection" ? `\0${override.resourceKind}` : ""}`;
}

function resourceKindForNode(nodeType: WorkflowNodeTypeKey): WorkflowResourceKind | undefined {
  if (nodeType === "context.memory") return "memory";
  if (nodeType === "context.project") return "project";
  if (nodeType === "policy.rules") return "rule";
  if (nodeType === "capability.skills") return "skill";
  return undefined;
}

function resourcePrefix(kind: WorkflowResourceKind): string {
  if (kind === "memory") return "mrs";
  if (kind === "project") return "prj";
  if (kind === "rule") return "rul";
  return "skl";
}

function resourceKey(kind: WorkflowResourceKind, id: string): string {
  return `${kind}\0${id}`;
}

function policyDiagnostic(
  code: string,
  path: string,
  params: Readonly<Record<string, string | number | boolean>>,
): WorkflowDiagnostic {
  return { family: "policy_denied", code, path, params };
}

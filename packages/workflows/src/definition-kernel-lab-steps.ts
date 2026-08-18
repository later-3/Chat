import { FatalError } from "workflow";
import { z } from "zod";
import {
  DEFAULT_NODE_CATALOG,
  DEFAULT_WORKFLOW_BLUEPRINTS,
  validateDefinitionAgainstBlueprint,
} from "@chat/application";
import { workflowRunSpecSchema, type WorkflowRunSpec } from "@chat/contracts";
import {
  WORKFLOW_KERNEL_LIMITS,
  canonicalJsonStringify,
  hashCanonical,
  sha256Hex,
  validateWorkflowStructure,
  type WorkflowNodeTypeKey,
} from "@chat/domain";
import {
  DEFINITION_KERNEL_EXECUTORS,
  DEFINITION_KERNEL_RUNNER_BUNDLE_VERSION,
  DEFINITION_KERNEL_RUNNER_FAMILY,
} from "./definition-kernel-executor-registry.js";
import {
  getKernelLabRuntimePort,
  type KernelLabSettlement,
  type KernelNodeControlResult,
  type KernelNodeExecutionContext,
  type KernelNodeExecutionScope,
  type KernelPreparedComposite,
} from "./definition-kernel-lab-runtime.js";

const controlResultSchema = z.strictObject({
  outcomeCode: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  outputRefs: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(64),
        refId: z.string().min(3).max(128),
        revision: z.number().int().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(WORKFLOW_KERNEL_LIMITS.projection.maxManifestSlots)
    .optional(),
});

const preparedCompositeSchema = controlResultSchema.extend({
  actionManifest: z.strictObject({
    actions: z
      .array(
        z.strictObject({
          actionId: z
            .string()
            .min(1)
            .max(80)
            .regex(/^[a-z][a-z0-9._-]*$/),
          title: z.string().min(1).max(120),
        }),
      )
      .max(WORKFLOW_KERNEL_LIMITS.runtime.maxCompositeChildren),
  }),
});

export async function loadDefinitionKernelRunSpecStep(input: {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
}): Promise<WorkflowRunSpec> {
  "use step";
  const loaded = await getKernelLabRuntimePort().loadRunSpec(input);
  const parsed = workflowRunSpecSchema.safeParse(loaded);
  if (!parsed.success) throw new FatalError("run_spec.schema_invalid");
  const runSpec = parsed.data;
  const { sha256 } = runSpec;
  const hashPayload = { ...runSpec } as Record<string, unknown>;
  for (const key of ["schemaVersion", "workflowRunSpecId", "productRunId", "sha256", "createdAt"]) {
    delete hashPayload[key];
  }
  if (hashCanonical("workflow-run-spec.v1", hashPayload) !== sha256) {
    throw new FatalError("run_spec.hash_mismatch");
  }
  if (
    runSpec.workflowRunSpecId !== input.workflowRunSpecId ||
    runSpec.productRunId !== input.productRunId
  ) {
    throw new FatalError("run_spec.identity_mismatch");
  }
  if (
    runSpec.runner.runnerFamily !== DEFINITION_KERNEL_RUNNER_FAMILY ||
    runSpec.runner.runnerBundleVersion !== DEFINITION_KERNEL_RUNNER_BUNDLE_VERSION
  ) {
    throw new FatalError("run_spec.runner_version_incompatible");
  }
  if (canonicalJsonStringify(runSpec.limits) !== canonicalJsonStringify(WORKFLOW_KERNEL_LIMITS)) {
    throw new FatalError("run_spec.limits_incompatible");
  }
  const manifest = new Map(
    runSpec.executorManifest.map((entry) => [
      `${entry.nodeType}@${String(entry.schemaVersion)}`,
      entry.executorVersion,
    ]),
  );
  for (const registration of DEFINITION_KERNEL_EXECUTORS.list()) {
    const key = `${registration.nodeType}@${String(registration.schemaVersion)}`;
    if (manifest.get(key) !== registration.executorVersion) {
      throw new FatalError("run_spec.executor_manifest_incompatible");
    }
  }
  const structure = validateWorkflowStructure(runSpec.semanticRoot, {
    outcomesFor: (nodeType, schemaVersion) =>
      DEFAULT_NODE_CATALOG.get(nodeType, schemaVersion)?.outcomes,
  });
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    runSpec.definitionRef.blueprintKey,
    runSpec.definitionRef.blueprintVersion,
  );
  if (blueprint === undefined) throw new FatalError("run_spec.blueprint_incompatible");
  const blueprintDiagnostics = validateDefinitionAgainstBlueprint(
    runSpec.semanticRoot,
    blueprint,
    DEFAULT_NODE_CATALOG,
  );
  if (structure.diagnostics.length > 0 || blueprintDiagnostics.length > 0) {
    throw new FatalError("run_spec.semantic_structure_invalid");
  }
  return runSpec;
}

export async function executeDefinitionKernelNodeStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
}): Promise<KernelNodeControlResult> {
  "use step";
  const registration = DEFINITION_KERNEL_EXECUTORS.get(input.nodeType, input.schemaVersion);
  if (registration === undefined || registration.executorKind !== "step") {
    throw new FatalError("executor_registry.step_not_found");
  }
  const port = getKernelLabRuntimePort();
  const context = withCommand(input.context, registration.operation);
  let raw: KernelNodeControlResult;
  switch (registration.operation) {
    case "query_memory":
      raw = await port.queryMemory(context);
      break;
    case "write_memory":
      raw = await port.writeMemory(context);
      break;
    case "load_memory_context":
      raw = await port.loadMemoryContext(context);
      break;
    case "load_project_context":
      raw = await port.loadProjectContext(context);
      break;
    case "resolve_rules":
      raw = await port.resolveRules(context);
      break;
    case "resolve_skills":
      raw = await port.resolveSkills(context);
      break;
    case "research":
      raw = await port.research(context);
      break;
    case "plan":
      raw = await port.plan(context);
      break;
    case "validate_result":
      raw = await port.validateResult(context);
      break;
    case "commit_product":
      raw = await port.commitProduct(context);
      break;
    case "extract_note":
      raw = await port.extractNote(context);
      break;
    case "classify_note":
      raw = await port.classifyNote(context);
      break;
    case "commit_note":
      raw = await port.commitNote(context);
      break;
    case "review_plan":
    case "review_note":
    case "execute_plan":
      throw new FatalError("executor_registry.wrong_dispatch_kind");
    default: {
      const exhaustive: never = registration.operation;
      throw new FatalError(`executor_registry.unknown_operation:${exhaustive}`);
    }
  }
  return parseNodeResult(input.nodeType, input.schemaVersion, raw);
}

export async function skipDefinitionKernelNodeStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly nodeType: WorkflowNodeTypeKey;
  readonly schemaVersion: number;
  readonly outcomeCode: string;
}): Promise<KernelNodeControlResult> {
  "use step";
  const descriptor = DEFAULT_NODE_CATALOG.get(input.nodeType, input.schemaVersion);
  if (
    descriptor === undefined ||
    descriptor.skipPolicy.kind !== "allowed_with_default_outcome" ||
    descriptor.skipPolicy.defaultOutcome !== input.outcomeCode
  ) {
    throw new FatalError("policy.runtime_skip_denied");
  }
  const result = await getKernelLabRuntimePort().recordSkipped({
    context: withCommand(input.context, "skip"),
    nodeType: input.nodeType,
    outcomeCode: input.outcomeCode,
  });
  return parseNodeResult(input.nodeType, input.schemaVersion, result);
}

export async function beginDefinitionKernelReviewStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly nodeType: "human.plan_review" | "human.note_review";
}): Promise<{ readonly reviewRef: string }> {
  "use step";
  const result =
    input.nodeType === "human.plan_review"
      ? await getKernelLabRuntimePort().beginPlanReview(
          withCommand(input.context, "begin_plan_review"),
        )
      : await getKernelLabRuntimePort().beginNoteReview(
          withCommand(input.context, "begin_note_review"),
        );
  return z.strictObject({ reviewRef: z.string().min(3).max(128) }).parse(result);
}

export async function loadDefinitionKernelDecisionStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly nodeType: "human.plan_review" | "human.note_review";
  readonly reviewRef: string;
  readonly decisionRef: string;
}): Promise<KernelNodeControlResult> {
  "use step";
  // Hook只传Decision引用；Port必须按reviewRef重读已经提交的产品Decision事实。
  const commandInput = {
    ...input,
    context: withCommand(input.context, "load_committed_decision"),
  };
  const result =
    input.nodeType === "human.plan_review"
      ? await getKernelLabRuntimePort().loadCommittedPlanDecision(commandInput)
      : await getKernelLabRuntimePort().loadCommittedNoteDecision(commandInput);
  return parseNodeResult(input.nodeType, 1, result);
}

export async function autoContinueDefinitionKernelReviewStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly nodeType: "human.plan_review" | "human.note_review";
  readonly policyRef: {
    readonly resourceId: string;
    readonly revision: number;
    readonly sha256: string;
  };
}): Promise<KernelNodeControlResult> {
  "use step";
  const result = await getKernelLabRuntimePort().recordPolicyAutoContinue({
    ...input,
    context: withCommand(input.context, "policy_auto_continue"),
  });
  return parseNodeResult(input.nodeType, 1, result);
}

export async function prepareDefinitionKernelCompositeStep(input: {
  readonly context: KernelNodeExecutionScope;
}): Promise<KernelPreparedComposite> {
  "use step";
  return preparedCompositeSchema.parse(
    await getKernelLabRuntimePort().prepareExecutePlan(
      withCommand(input.context, "prepare_execute_plan"),
    ),
  );
}

export async function executeDefinitionKernelCompositeChildStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly actionId: string;
}): Promise<KernelNodeControlResult> {
  "use step";
  return controlResultSchema.parse(
    await getKernelLabRuntimePort().executePlanAction({
      ...input,
      context: withCommand(input.context, `execute_action:${input.actionId}`),
    }),
  );
}

export async function completeDefinitionKernelCompositeStep(input: {
  readonly context: KernelNodeExecutionScope;
  readonly outcomeCode: "success" | "failed" | "outcome_unknown";
}): Promise<KernelNodeControlResult> {
  "use step";
  const result = await getKernelLabRuntimePort().completeExecutePlan({
    ...input,
    context: withCommand(input.context, "complete_execute_plan"),
  });
  return parseNodeResult("execute.plan", 1, result);
}

export async function beginDefinitionKernelLoopLimitReviewStep(input: {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
  readonly executionPath: string;
}): Promise<{ readonly reviewRef: string }> {
  "use step";
  return z.strictObject({ reviewRef: z.string().min(3).max(128) }).parse(
    await getKernelLabRuntimePort().beginLoopLimitReview({
      ...input,
      commandId: commandId(
        input.workflowRunSpecId,
        input.productRunId,
        1,
        input.executionPath,
        "begin_loop_limit_review",
      ),
    }),
  );
}

export async function loadDefinitionKernelLoopLimitDecisionStep(input: {
  readonly reviewRef: string;
  readonly decisionRef: string;
}): Promise<{ readonly outcomeCode: "stop" }> {
  "use step";
  return z
    .strictObject({ outcomeCode: z.literal("stop") })
    .parse(await getKernelLabRuntimePort().loadCommittedLoopLimitDecision(input));
}

export async function markDefinitionKernelReviewHookReadyStep(input: {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
  readonly executionPath: string;
  readonly reviewRef: string;
}): Promise<void> {
  "use step";
  await getKernelLabRuntimePort().markReviewHookReady({
    reviewRef: input.reviewRef,
    commandId: commandId(
      input.workflowRunSpecId,
      input.productRunId,
      1,
      input.executionPath,
      "mark_review_hook_ready",
    ),
  });
}

export async function settleDefinitionKernelLabStep(input: {
  readonly workflowRunSpecId: string;
  readonly productRunId: string;
  readonly settlement: KernelLabSettlement;
}): Promise<KernelLabSettlement> {
  "use step";
  return getKernelLabRuntimePort().settle({
    ...input,
    commandId: commandId(
      input.workflowRunSpecId,
      input.productRunId,
      1,
      "settle",
      input.settlement.outcome,
    ),
  });
}

function withCommand(
  scope: KernelNodeExecutionScope,
  operation: string,
): KernelNodeExecutionContext {
  return {
    ...scope,
    commandId: commandId(
      scope.workflowRunSpecId,
      scope.productRunId,
      scope.attemptNumber,
      scope.executionPath,
      operation,
    ),
  };
}

function commandId(
  workflowRunSpecId: string,
  productRunId: string,
  attemptNumber: number,
  executionPath: string,
  operation: string,
): string {
  return `cmd_${sha256Hex(
    [workflowRunSpecId, productRunId, String(attemptNumber), executionPath, operation].join("\0"),
  ).slice(0, 32)}`;
}

function parseNodeResult(
  nodeType: WorkflowNodeTypeKey,
  schemaVersion: number,
  input: unknown,
): KernelNodeControlResult {
  const parsed = controlResultSchema.parse(input);
  const descriptor = DEFAULT_NODE_CATALOG.get(nodeType, schemaVersion);
  if (descriptor === undefined || !descriptor.outcomes.includes(parsed.outcomeCode)) {
    throw new FatalError("executor.outcome_not_declared");
  }
  return parsed;
}

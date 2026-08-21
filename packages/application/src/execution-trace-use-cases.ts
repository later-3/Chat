import {
  WORKFLOW_EXECUTION_TRACE_SCHEMA_VERSION,
  WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
  workflowExecutionTraceDtoSchema,
  type ExecutionStepTraceDto,
  type WorkflowExecutionTraceDto,
  type WorkflowExecutionTraceValueDto,
  type NodeProductRef,
  type PiTraceActivityDto,
  type PrincipalId,
  type ProductSnapshot,
  type ProductRunId,
  type RunAttemptId,
  type RunActivityEvent,
  type WorkflowNodeRunSummaryDto,
  type WorkflowNodeTraceDetailDto,
  type WorkflowRuntimeTraceDto,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { getProductRun } from "./query-use-cases.js";
import { getWorkflowRunView } from "./workflow-query-use-cases.js";

interface MutableActivity {
  activityKey: PiTraceActivityDto["activityKey"];
  parentActivityKey?: PiTraceActivityDto["activityKey"];
  attemptId: RunAttemptId;
  workflowNodeRunId?: PiTraceActivityDto["workflowNodeRunId"];
  executionStepId?: string;
  sequence: number;
  kind: PiTraceActivityDto["kind"];
  label: string;
  status: PiTraceActivityDto["status"];
  nodeKind: PiTraceActivityDto["nodeKind"];
  toolName?: string;
  inputDisplay?: string;
  inputDisplayTruncated?: boolean;
  resultDisplay?: string;
  resultDisplayTruncated?: boolean;
  provider?: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: PiTraceActivityDto["tokenUsage"];
  errorCode?: string;
}

interface PiAttemptBinding {
  readonly workflowNodeRunId: NonNullable<PiTraceActivityDto["workflowNodeRunId"]>;
  readonly executionStepId?: string;
}

const AGENT_LABELS: Record<PiTraceActivityDto["nodeKind"], string> = {
  planner: "规划 Agent",
  executor: "执行 Agent",
  direct_agent: "直接 Agent",
  note_capture: "笔记捕获 Agent",
};

function roundedDuration(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}

const TRACE_VALUE_MAX_CHARACTERS = 64_000;

function boundedText(value: string): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= TRACE_VALUE_MAX_CHARACTERS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, TRACE_VALUE_MAX_CHARACTERS - 1)}…`,
    truncated: true,
  };
}

function traceValue(input: {
  readonly label: string;
  readonly format: WorkflowExecutionTraceValueDto["format"];
  readonly value: string;
  readonly source?: NodeProductRef;
}): WorkflowExecutionTraceValueDto {
  const bounded = boundedText(input.value);
  return {
    label: input.label.slice(0, 240),
    format: input.format,
    text: bounded.text,
    truncated: bounded.truncated,
    ...(input.source === undefined ? {} : { source: { ...input.source } }),
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

/** 只解析公开轨迹需要的产品正文；未知Ref仍显示不可变引用，不猜测其他聚合结构。 */
function resolveProductRef(
  snapshot: ProductSnapshot,
  slot: string,
  ref: NodeProductRef,
): WorkflowExecutionTraceValueDto {
  const label = `${slot} · ${ref.label}`;
  switch (ref.kind) {
    case "message": {
      const message = snapshot.entities.messages[ref.id];
      if (message !== undefined) {
        return traceValue({
          label,
          format: "markdown",
          value: message.content.text,
          source: ref,
        });
      }
      break;
    }
    case "plan_revision": {
      const plan = snapshot.entities.plans[ref.id];
      if (plan !== undefined) {
        return traceValue({
          label,
          format: "json",
          value: jsonText({
            planRevision: plan.planRevision,
            status: plan.status,
            content: plan.content,
          }),
          source: ref,
        });
      }
      break;
    }
    case "approval_request": {
      const approval = snapshot.entities.approvalRequests[ref.id];
      if (approval !== undefined) {
        return traceValue({
          label,
          format: "json",
          value: jsonText({
            status: approval.status,
            planId: approval.planId,
            planRevision: approval.planRevision,
            expiresAt: approval.expiresAt,
            decidedByDecisionId: approval.decidedByDecisionId ?? null,
            createdAt: approval.createdAt,
            updatedAt: approval.updatedAt,
          }),
          source: ref,
        });
      }
      break;
    }
    case "decision": {
      const decision = snapshot.entities.decisions[ref.id];
      if (decision !== undefined) {
        return traceValue({
          label,
          format: "json",
          value: jsonText({
            kind: decision.kind,
            principalId: decision.principalId,
            planId: decision.planId,
            planRevision: decision.planRevision,
            createdAt: decision.createdAt,
          }),
          source: ref,
        });
      }
      break;
    }
    case "execution_contract": {
      const contract = snapshot.entities.executionContracts[ref.id];
      if (contract !== undefined) {
        return traceValue({
          label,
          format: "json",
          value: jsonText({
            approvedPlanId: contract.approvedPlanId,
            approvedPlanRevision: contract.approvedPlanRevision,
            approvalDecisionId: contract.approvalDecisionId,
            steps: contract.steps,
            completionCriteria: contract.completionCriteria,
            capabilityRefs: contract.capabilityRefs,
            limits: contract.limits,
          }),
          source: ref,
        });
      }
      break;
    }
    case "execution_candidate": {
      const candidate = snapshot.entities.executionCandidates[ref.id];
      if (candidate !== undefined) {
        return traceValue({
          label,
          format: "json",
          value: jsonText({
            stepResults: candidate.stepResults,
            finalOutput: candidate.finalOutput,
            completionCriteriaEvidence: candidate.completionCriteriaEvidence,
            warnings: candidate.warnings,
          }),
          source: ref,
        });
      }
      break;
    }
    case "validation_result": {
      const validation = snapshot.entities.validationResults[ref.id];
      if (validation !== undefined) {
        return traceValue({
          label,
          format: "json",
          value: jsonText({
            strictEvidence: validation.strictEvidence,
            outcome: validation.outcome,
            failures: validation.failures,
            createdAt: validation.createdAt,
          }),
          source: ref,
        });
      }
      break;
    }
    default:
      break;
  }
  return traceValue({ label, format: "json", value: jsonText(ref), source: ref });
}

function manifestValues(
  snapshot: ProductSnapshot,
  manifestId: string | undefined,
): WorkflowExecutionTraceValueDto[] {
  if (manifestId === undefined) return [];
  const manifest = snapshot.entities.nodeValueManifests[manifestId];
  if (manifest === undefined) return [];
  return manifest.slots.flatMap((slot) =>
    slot.refs.map((ref) => resolveProductRef(snapshot, slot.name, ref)),
  );
}

function planningInputEvidence(
  snapshot: ProductSnapshot,
  node: WorkflowNodeRunSummaryDto,
): WorkflowExecutionTraceValueDto[] {
  if (node.nodeType !== "agent.plan") return [];
  const planRevision = node.executionPath.at(-1)?.iteration;
  const attempt = Object.values(snapshot.entities.attempts).find(
    (candidate) =>
      candidate.productRunId ===
        snapshot.entities.workflowNodeRuns[node.workflowNodeRunId]?.productRunId &&
      candidate.kind === "planning" &&
      candidate.planRevision === planRevision,
  );
  if (attempt === undefined) return [];
  return [
    traceValue({
      label: "规划输入证据（不是 Provider 原始 Payload）",
      format: "json",
      value: jsonText({
        inputManifestSha256: attempt.inputManifestSha256 ?? null,
        sourceMessageSha256: attempt.sourceMessageSha256 ?? null,
        promptTemplateVersion: attempt.promptTemplateVersion ?? null,
        modelConfigVersion: attempt.modelConfigVersion ?? null,
        contextPackageId: attempt.contextPackageId ?? null,
        planningMemorySelectionId: attempt.planningMemorySelectionId ?? null,
        planningProjectContextId: attempt.planningProjectContextId ?? null,
        ruleSelectionId: attempt.ruleSelectionId ?? null,
      }),
    }),
  ];
}

function buildNodeDetails(
  snapshot: ProductSnapshot,
  nodes: readonly WorkflowNodeRunSummaryDto[],
): WorkflowNodeTraceDetailDto[] {
  return nodes.map((node) => {
    const stored = snapshot.entities.workflowNodeRuns[node.workflowNodeRunId];
    return {
      workflowNodeRunId: node.workflowNodeRunId,
      input: [
        ...manifestValues(snapshot, stored?.inputManifestId),
        ...planningInputEvidence(snapshot, node),
      ],
      output: manifestValues(snapshot, stored?.outputManifestId),
    };
  });
}

function executionStepStatus(
  outcome: "running" | "success" | "failure",
): ExecutionStepTraceDto["status"] {
  return outcome === "success" ? "succeeded" : outcome === "failure" ? "failed" : "running";
}

function elapsedMs(startedAt: string, completedAt: string | undefined): number | undefined {
  if (completedAt === undefined) return undefined;
  return Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
}

function buildExecutionSteps(
  snapshot: ProductSnapshot,
  productRunId: ProductRunId,
  nodes: readonly WorkflowNodeRunSummaryDto[],
): ExecutionStepTraceDto[] {
  const parent = nodes.find((node) => node.nodeType === "execute.plan");
  const contract = Object.values(snapshot.entities.executionContracts).find(
    (candidate) => candidate.productRunId === productRunId,
  );
  if (parent === undefined || contract === undefined) return [];
  const candidate = Object.values(snapshot.entities.executionCandidates).find(
    (value) => value.productRunId === productRunId,
  );
  const contractRef: NodeProductRef = {
    kind: "execution_contract",
    id: contract.executionContractId,
    revision: contract.revision,
    sha256: contract.sha256,
    label: "执行合同",
  };
  const candidateRef: NodeProductRef | undefined =
    candidate === undefined
      ? undefined
      : {
          kind: "execution_candidate",
          id: candidate.executionCandidateId,
          revision: candidate.revision,
          sha256: candidate.sha256,
          label: "执行候选结果",
        };
  return contract.steps.flatMap((step) => {
    const attempt = Object.values(snapshot.entities.attempts)
      .filter(
        (value) =>
          value.productRunId === productRunId &&
          value.kind === "execution" &&
          value.stepId === step.stepId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const result = candidate?.stepResults.find((value) => value.stepId === step.stepId);
    if (attempt === undefined && result === undefined) return [];
    const status =
      result === undefined ? executionStepStatus(attempt?.outcome ?? "running") : "succeeded";
    const startedAt = attempt?.createdAt;
    const completedAt =
      attempt === undefined || attempt.outcome === "running" ? undefined : attempt.updatedAt;
    const input = traceValue({
      label: `执行步骤输入 · ${step.title}`,
      format: "json",
      value: jsonText({
        completionCriteria: contract.completionCriteria,
        step,
        selectedContextRefs: step.inputRefs,
        dependencyRefs: result?.dependencyRefs ?? [],
        inputManifestSha256: attempt?.inputManifestSha256 ?? null,
        promptTemplateVersion: attempt?.promptTemplateVersion ?? null,
        modelConfigVersion: attempt?.modelConfigVersion ?? null,
      }),
      source: contractRef,
    });
    const output =
      result === undefined || candidateRef === undefined
        ? []
        : [
            traceValue({
              label: `执行步骤输出 · ${step.title}`,
              format: "json",
              value: jsonText(result),
              source: candidateRef,
            }),
          ];
    const durationMs = startedAt === undefined ? undefined : elapsedMs(startedAt, completedAt);
    return [
      {
        parentWorkflowNodeRunId: parent.workflowNodeRunId,
        stepId: step.stepId,
        title: step.title,
        status,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(durationMs === undefined ? {} : { durationMs }),
        input: [input],
        output,
      },
    ];
  });
}

function buildPiAttemptBindings(
  snapshot: ProductSnapshot,
  productRunId: ProductRunId,
  nodes: readonly WorkflowNodeRunSummaryDto[],
): ReadonlyMap<string, PiAttemptBinding> {
  const bindings = new Map<string, PiAttemptBinding>();
  const planningNodes = nodes.filter((node) => node.nodeType === "agent.plan");
  const executeNode = nodes.find((node) => node.nodeType === "execute.plan");
  for (const attempt of Object.values(snapshot.entities.attempts)) {
    if (attempt.productRunId !== productRunId) continue;
    if (attempt.kind === "planning") {
      const node =
        planningNodes.find(
          (candidate) => candidate.executionPath.at(-1)?.iteration === attempt.planRevision,
        ) ?? planningNodes[0];
      if (node !== undefined) {
        bindings.set(attempt.attemptId, { workflowNodeRunId: node.workflowNodeRunId });
      }
    } else if (
      attempt.kind === "execution" &&
      executeNode !== undefined &&
      attempt.stepId !== undefined
    ) {
      bindings.set(attempt.attemptId, {
        workflowNodeRunId: executeNode.workflowNodeRunId,
        executionStepId: attempt.stepId,
      });
    } else if (attempt.kind === "direct_agent") {
      const node = nodes.find((candidate) => candidate.nodeType === "agent.direct");
      if (node !== undefined) {
        bindings.set(attempt.attemptId, { workflowNodeRunId: node.workflowNodeRunId });
      }
    }
  }
  return bindings;
}

function assertActivityAttemptOwnership(
  snapshot: ProductSnapshot,
  productRunId: ProductRunId,
  events: readonly RunActivityEvent[],
): void {
  const ownedAttempts = new Set(
    Object.values(snapshot.entities.attempts)
      .filter((attempt) => attempt.productRunId === productRunId)
      .map((attempt) => attempt.attemptId),
  );
  for (const event of events) {
    if (event.attemptId !== undefined && !ownedAttempts.has(event.attemptId)) {
      throw new Error(
        `Run Activity Attempt不属于当前Product Run：${event.attemptId} -> ${productRunId}`,
      );
    }
  }
}

/**
 * Pi Agent原始事件按Attempt聚合为Agent -> Model/Tool两层公开活动。
 * 只复制严格合同白名单字段，不读取参数、结果、Prompt或Provider响应正文。
 */
export function projectPiActivities(
  events: readonly RunActivityEvent[],
  attemptBindings: ReadonlyMap<string, PiAttemptBinding> = new Map(),
): PiTraceActivityDto[] {
  const activities: MutableActivity[] = [];
  const agents = new Map<string, MutableActivity>();
  const tools = new Map<string, MutableActivity>();
  const openModels = new Map<string, MutableActivity[]>();
  const counters = { agent: 0, model: 0, tool: 0 };
  let sequence = 0;

  const nextKey = (kind: keyof typeof counters): PiTraceActivityDto["activityKey"] => {
    counters[kind] += 1;
    return `pi-${kind}-${String(counters[kind])}` as PiTraceActivityDto["activityKey"];
  };
  const ensureAgent = (
    event: Extract<RunActivityEvent, { activityType: "agent" }>,
  ): MutableActivity => {
    if (event.attemptId === undefined) throw new Error("Agent Activity缺少Attempt身份");
    const identity = `${event.attemptId}:${event.nodeKind}`;
    const existing = agents.get(identity);
    if (existing !== undefined) return existing;
    const binding = attemptBindings.get(event.attemptId);
    const activity: MutableActivity = {
      activityKey: nextKey("agent"),
      attemptId: event.attemptId,
      ...(binding?.workflowNodeRunId === undefined
        ? {}
        : { workflowNodeRunId: binding.workflowNodeRunId }),
      ...(binding?.executionStepId === undefined
        ? {}
        : { executionStepId: binding.executionStepId }),
      sequence: ++sequence,
      kind: "agent",
      label: AGENT_LABELS[event.nodeKind],
      status: "running",
      nodeKind: event.nodeKind,
      startedAt: event.timestamp,
    };
    agents.set(identity, activity);
    activities.push(activity);
    return activity;
  };

  for (const event of events) {
    if (event.activityType === "agent") {
      if (event.phase === "started") {
        ensureAgent(event);
      } else {
        const activity = ensureAgent(event);
        activity.status =
          event.phase === "completed"
            ? "succeeded"
            : event.phase === "cancelled"
              ? "cancelled"
              : event.phase === "outcome_unknown"
                ? "outcome_unknown"
                : "failed";
        activity.completedAt = event.timestamp;
        const durationMs = roundedDuration(event.durationMs);
        if (durationMs !== undefined) activity.durationMs = durationMs;
        if (event.errorCode !== undefined) activity.errorCode = event.errorCode;
      }
      continue;
    }
    if (event.activityType === "model") {
      if (event.attemptId === undefined) continue;
      if (event.phase === "started") {
        const parent =
          agents.get(`${event.attemptId}:${event.nodeKind}`) ??
          ensureAgent({
            ...event,
            activityType: "agent",
            phase: "started",
            nodeKind: event.nodeKind,
          });
        if (parent === undefined) break;
        const activity: MutableActivity = {
          activityKey: nextKey("model"),
          parentActivityKey: parent.activityKey,
          attemptId: event.attemptId,
          ...(parent.workflowNodeRunId === undefined
            ? {}
            : { workflowNodeRunId: parent.workflowNodeRunId }),
          ...(parent.executionStepId === undefined
            ? {}
            : { executionStepId: parent.executionStepId }),
          sequence: ++sequence,
          kind: "model",
          label: `模型调用：${event.provider}/${event.model}`,
          status: "running",
          nodeKind: parent.nodeKind,
          provider: event.provider,
          model: event.model,
          startedAt: event.timestamp,
        };
        const list = openModels.get(event.attemptId) ?? [];
        list.push(activity);
        openModels.set(event.attemptId, list);
        activities.push(activity);
      } else {
        const activity = openModels
          .get(event.attemptId)
          ?.find((candidate) => candidate.status === "running");
        if (activity === undefined) continue;
        activity.status = event.phase === "completed" ? "succeeded" : "failed";
        activity.completedAt = event.timestamp;
        const durationMs = roundedDuration(event.durationMs);
        if (durationMs !== undefined) activity.durationMs = durationMs;
        if (event.tokenUsage !== undefined) activity.tokenUsage = event.tokenUsage;
        if (event.errorCode !== undefined) activity.errorCode = event.errorCode;
      }
      continue;
    }
    if (event.activityType === "tool" && event.attemptId !== undefined) {
      if (event.phase === "started") {
        const nodeKind = event.nodeKind ?? "executor";
        const parent = agents.get(`${event.attemptId}:${nodeKind}`);
        if (parent === undefined) continue;
        const identity = `${event.attemptId}:${event.toolCallId}`;
        if (tools.has(identity)) continue;
        const activity: MutableActivity = {
          activityKey: nextKey("tool"),
          parentActivityKey: parent.activityKey,
          attemptId: event.attemptId,
          ...(parent.workflowNodeRunId === undefined
            ? {}
            : { workflowNodeRunId: parent.workflowNodeRunId }),
          ...(parent.executionStepId === undefined
            ? {}
            : { executionStepId: parent.executionStepId }),
          sequence: ++sequence,
          kind: "tool",
          label: `工具：${event.toolName}`,
          status: "running",
          nodeKind: parent.nodeKind,
          toolName: event.toolName,
          ...(event.inputDisplay === undefined ? {} : { inputDisplay: event.inputDisplay }),
          ...(event.inputDisplayTruncated === undefined
            ? {}
            : { inputDisplayTruncated: event.inputDisplayTruncated }),
          startedAt: event.timestamp,
        };
        tools.set(identity, activity);
        activities.push(activity);
      } else {
        const activity = tools.get(`${event.attemptId}:${event.toolCallId}`);
        if (activity === undefined) continue;
        activity.status =
          event.phase === "completed"
            ? "succeeded"
            : event.phase === "blocked"
              ? "blocked"
              : event.phase === "outcome_unknown"
                ? "outcome_unknown"
                : "failed";
        activity.completedAt = event.timestamp;
        const durationMs = roundedDuration(event.durationMs);
        if (durationMs !== undefined) activity.durationMs = durationMs;
        if (event.resultDisplay !== undefined) activity.resultDisplay = event.resultDisplay;
        if (event.resultDisplayTruncated !== undefined)
          activity.resultDisplayTruncated = event.resultDisplayTruncated;
        if (event.errorCode !== undefined) activity.errorCode = event.errorCode;
      }
      continue;
    }
  }

  return activities.map((activity) =>
    workflowExecutionTraceDtoSchema.shape.piActivities.element.parse(activity),
  );
}

/**
 * DSH当前树只发布最近的完整Agent分组，绝不让500上限把父Agent截掉后留下孤儿Tool。
 * 完整Run Activity仍在Journal中，可由cursor接口分页读取。
 */
export function boundPiActivities(
  activities: readonly PiTraceActivityDto[],
  limit = 500,
): { readonly items: PiTraceActivityDto[]; readonly truncated: boolean } {
  if (activities.length <= limit) return { items: [...activities], truncated: false };
  const groups = activities
    .filter((activity) => activity.kind === "agent")
    .map((agent) => ({
      agent,
      children: activities.filter((activity) => activity.parentActivityKey === agent.activityKey),
    }));
  const selected: PiTraceActivityDto[] = [];
  for (const group of [...groups].reverse()) {
    const remaining = limit - selected.length;
    if (remaining <= 0) break;
    const values = [group.agent, ...group.children];
    if (values.length <= remaining) {
      selected.push(...values);
      continue;
    }
    if (selected.length === 0) {
      selected.push(group.agent, ...group.children.slice(-(limit - 1)));
    }
    break;
  }
  return { items: selected.sort((left, right) => left.sequence - right.sequence), truncated: true };
}

function unavailableRuntime(productRunId: ProductRunId): WorkflowRuntimeTraceDto {
  return {
    schemaVersion: WORKFLOW_RUNTIME_TRACE_SCHEMA_VERSION,
    productRunId,
    sourceKind: "vercel_workflow",
    availability: "unavailable",
    reason: "not_recorded",
    refreshAfterMs: null,
    refreshedAt: new Date(0).toISOString(),
  };
}

/** 为确定性修订号生成不含undefined的Runtime公开投影。 */
export function runtimeRevisionValue(runtime: WorkflowRuntimeTraceDto): unknown {
  if (runtime.availability !== "available") {
    return { availability: runtime.availability, reason: runtime.reason };
  }
  return {
    availability: runtime.availability,
    runtimeStatus: runtime.runtimeStatus,
    eventCount: runtime.eventCount,
    truncated: runtime.truncated,
    spans: runtime.spans.map((span) => ({
      spanKey: span.spanKey,
      kind: span.kind,
      status: span.status,
      createdAt: span.createdAt,
      ...(span.startedAt === undefined ? {} : { startedAt: span.startedAt }),
      ...(span.completedAt === undefined ? {} : { completedAt: span.completedAt }),
      eventSequences: span.eventSequences,
    })),
    events: runtime.events,
  };
}

/** 轨迹只包含发生过的运行实例；Definition占位或skipped可选节点不伪装成执行记录。 */
export function executedWorkflowNodeRuns<T extends { readonly status: string }>(
  nodes: readonly T[],
): T[] {
  return nodes.filter((node) => node.status !== "queued" && node.status !== "skipped");
}

export async function getWorkflowExecutionTrace(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
): Promise<{ readonly value: WorkflowExecutionTraceDto; readonly etag: string }> {
  // 先经Product Query做权限判断；随后两个外部只读源才允许解析本Run。
  const [{ run }, workflowView] = await Promise.all([
    getProductRun(deps, input),
    getWorkflowRunView(deps, input),
  ]);
  const [{ snapshot }, runtime, activityEvents] = await Promise.all([
    deps.store.read({ kind: "committedSnapshot" }),
    deps.workflowRuntimeTrace?.read({ productRunId: input.productRunId }) ??
      Promise.resolve(unavailableRuntime(input.productRunId)),
    deps.runActivityReader?.read({ productRunId: input.productRunId }) ?? Promise.resolve([]),
  ]);
  // queued/skipped都没有真正开始，不是执行轨迹。若Memory误被真正执行，它不会被本过滤隐藏。
  const nodeRuns = executedWorkflowNodeRuns(workflowView.value.nodeRuns);
  const nodeDetails = buildNodeDetails(snapshot, nodeRuns);
  const executionSteps = buildExecutionSteps(snapshot, input.productRunId, nodeRuns);
  assertActivityAttemptOwnership(snapshot, input.productRunId, activityEvents);
  const attemptBindings = buildPiAttemptBindings(snapshot, input.productRunId, nodeRuns);
  const projectedPiActivities = projectPiActivities(activityEvents, attemptBindings);
  const boundedPiActivities = boundPiActivities(projectedPiActivities);
  const piActivities = boundedPiActivities.items;
  const revisionValue = {
    run: { status: run.status, phase: run.phase, revision: run.revision, updatedAt: run.updatedAt },
    workflow: {
      revision: workflowView.value.revision,
      nodeRuns: nodeRuns.map((node) => ({
        workflowNodeRunId: node.workflowNodeRunId,
        status: node.status,
        revision: node.revision,
        updatedAt: node.updatedAt,
      })),
      nodeDetails,
      executionSteps,
    },
    runtime: runtimeRevisionValue(runtime),
    piActivities,
  };
  const traceRevision = hashCanonical("execution-trace-projection.v1", revisionValue);
  const activityTimes = piActivities.flatMap((activity) => [
    activity.startedAt,
    ...(activity.completedAt === undefined ? [] : [activity.completedAt]),
  ]);
  const runtimeTimes =
    runtime.availability === "available" ? runtime.events.map((event) => event.recordedAt) : [];
  const updatedAt =
    [run.updatedAt, workflowView.value.updatedAt, ...activityTimes, ...runtimeTimes]
      .sort()
      .at(-1) ?? run.updatedAt;
  const value = workflowExecutionTraceDtoSchema.parse({
    schemaVersion: WORKFLOW_EXECUTION_TRACE_SCHEMA_VERSION,
    productRunId: input.productRunId,
    traceRevision,
    updatedAt,
    run: {
      status: run.status,
      phase: run.phase,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    workflow: { title: workflowView.value.title, nodeRuns, nodeDetails, executionSteps },
    runtime,
    piActivities,
    truncated:
      boundedPiActivities.truncated || (runtime.availability === "available" && runtime.truncated),
  });
  return { value, etag: `"${traceRevision}"` };
}

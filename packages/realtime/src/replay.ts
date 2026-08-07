import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  productSnapshotSchema,
  type Message,
  type PlanRevision,
  type ProductSnapshot,
  type TraceEvent,
  type TraceObjectRef,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { computePlanSha256 } from "@chat/application";
import { readTraceEvents } from "./trace-reader.js";

/**
 * Run Replay Assembler（任务书§16）。
 *
 * 完整回放 = Trace系统时间线 + Product Store正文与版本对象 + 版本证据。
 * - 回放不是重新执行：只按对象ID/revision/Hash读取并校验，不调用模型。
 * - 对象缺失、revision缺失、Hash不一致、Trace缺口或版本证据缺失
 *   全部显式标红并失败退出。
 * - PR/CI/截图证据默认不含正文；正文只在本地授权环境通过本工具查看。
 */

export interface ReplayObjectCheck {
  readonly ref: TraceObjectRef;
  readonly status: "ok" | "missing" | "revision_mismatch" | "hash_mismatch" | "unknown_type";
  readonly detail?: string;
}

export interface ReplayTimelineEntry {
  readonly timestamp: string;
  readonly eventName: string;
  readonly outcome: string;
  readonly refs: readonly ReplayObjectCheck[];
}

export interface RunReplayView {
  readonly productRunId: string;
  readonly gitSha: string;
  readonly workflowDefinitionVersions: readonly string[];
  readonly promptTemplateVersions: readonly string[];
  readonly modelConfigVersions: readonly string[];
  readonly run: { status: string; phase: string; revision: number } | null;
  readonly timeline: readonly ReplayTimelineEntry[];
  readonly failures: readonly string[];
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

function loadSnapshot(storePath: string): ProductSnapshot {
  let raw: string;
  try {
    raw = readFileSync(storePath, "utf8");
  } catch {
    throw new ReplayError(`无法读取Product Store: ${storePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReplayError("Product Store不是合法JSON");
  }
  const result = productSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    throw new ReplayError("Product Store Schema校验失败");
  }
  return result.data;
}

function messageSha256(message: Message): string {
  return hashCanonical("message.v1", {
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
  });
}

function checkRef(snapshot: ProductSnapshot, ref: TraceObjectRef): ReplayObjectCheck {
  switch (ref.objectType) {
    case "plan": {
      const plan = Object.values(snapshot.entities.plans).find(
        (candidate) => candidate.planId === ref.objectId,
      );
      if (plan === undefined) return { ref, status: "missing", detail: "Plan不存在" };
      return checkPlan(plan, ref);
    }
    case "decision": {
      const decision = snapshot.entities.decisions[ref.objectId as never];
      if (decision === undefined) return { ref, status: "missing", detail: "Decision不存在" };
      const expected = hashCanonical("decision.v1", {
        decisionId: decision.decisionId,
        approvalRequestId: decision.approvalRequestId,
        productRunId: decision.productRunId,
        planId: decision.planId,
        planRevision: decision.planRevision,
        planSha256: decision.planSha256,
        kind: decision.kind,
        ...(decision.revisionInputId !== undefined
          ? { revisionInputId: decision.revisionInputId }
          : {}),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        principalId: decision.principalId,
        commandId: decision.commandId,
      });
      if (expected !== ref.sha256)
        return { ref, status: "hash_mismatch", detail: "Decision Hash不一致" };
      return { ref, status: "ok" };
    }
    case "message": {
      const message = snapshot.entities.messages[ref.objectId as never];
      if (message === undefined) return { ref, status: "missing", detail: "Message不存在" };
      if (messageSha256(message) !== ref.sha256) {
        return { ref, status: "hash_mismatch", detail: "Message Hash不一致" };
      }
      return { ref, status: "ok" };
    }
    case "execution_contract": {
      const contract = snapshot.entities.executionContracts[ref.objectId as never];
      if (contract === undefined)
        return { ref, status: "missing", detail: "Execution Contract不存在" };
      if (contract.sha256 !== ref.sha256)
        return { ref, status: "hash_mismatch", detail: "Contract Hash不一致" };
      return { ref, status: "ok" };
    }
    case "execution_candidate": {
      const candidate = snapshot.entities.executionCandidates[ref.objectId as never];
      if (candidate === undefined)
        return { ref, status: "missing", detail: "Execution Candidate不存在" };
      if (candidate.sha256 !== ref.sha256)
        return { ref, status: "hash_mismatch", detail: "Candidate Hash不一致" };
      return { ref, status: "ok" };
    }
    default:
      return { ref, status: "unknown_type", detail: `暂不支持校验的对象类型:${ref.objectType}` };
  }
}

function checkPlan(plan: PlanRevision, ref: TraceObjectRef): ReplayObjectCheck {
  if ("revision" in ref && ref.revision !== undefined && plan.planRevision !== ref.revision) {
    return {
      ref,
      status: "revision_mismatch",
      detail: `期望revision ${String(ref.revision)}，实际${String(plan.planRevision)}`,
    };
  }
  const recomputed = computePlanSha256({
    planId: plan.planId,
    productRunId: plan.productRunId,
    planRevision: plan.planRevision,
    content: plan.content,
  });
  if (recomputed !== ref.sha256) return { ref, status: "hash_mismatch", detail: "Plan Hash不一致" };
  return { ref, status: "ok" };
}

function eventRefs(event: TraceEvent): TraceObjectRef[] {
  const refs: TraceObjectRef[] = [];
  if ("planRef" in event && event.planRef !== undefined) refs.push(event.planRef);
  if ("decisionRef" in event && event.decisionRef !== undefined) refs.push(event.decisionRef);
  if ("candidateRef" in event && event.candidateRef !== undefined) refs.push(event.candidateRef);
  if ("outputRefs" in event && event.outputRefs !== undefined) refs.push(...event.outputRefs);
  if ("inputRefs" in event && event.inputRefs !== undefined) refs.push(...event.inputRefs);
  return refs;
}

export function assembleRunReplay(input: {
  productRunId: string;
  storePath: string;
  traceDir?: string | undefined;
  repoRoot?: string | undefined;
}): RunReplayView {
  const snapshot = loadSnapshot(input.storePath);
  const events = readTraceEvents({
    productRunId: input.productRunId,
    ...(input.traceDir !== undefined ? { dir: input.traceDir } : {}),
  });
  const failures: string[] = [];

  if (events.length === 0) {
    failures.push(`Trace缺口：找不到Product Run ${input.productRunId} 的任何事件`);
  }

  const workflowVersions = new Set<string>();
  const promptVersions = new Set<string>();
  const modelVersions = new Set<string>();
  for (const event of events) {
    if ("workflowDefinitionVersion" in event) workflowVersions.add(event.workflowDefinitionVersion);
    if ("promptTemplateVersion" in event) promptVersions.add(event.promptTemplateVersion);
    if ("modelConfigVersion" in event) modelVersions.add(event.modelConfigVersion);
  }
  if (
    events.some((event) => event.eventName.startsWith("workflow.")) &&
    workflowVersions.size === 0
  ) {
    failures.push("版本证据缺失：存在Workflow事件但没有workflowDefinitionVersion");
  }
  if (
    events.some(
      (event) => event.eventName.startsWith("provider.") || event.eventName.startsWith("pi."),
    ) &&
    (promptVersions.size === 0 || modelVersions.size === 0)
  ) {
    failures.push("版本证据缺失：存在模型事件但缺少promptTemplateVersion或modelConfigVersion");
  }

  const timeline: ReplayTimelineEntry[] = events.map((event) => {
    const refs = eventRefs(event).map((ref) => checkRef(snapshot, ref));
    for (const check of refs) {
      if (check.status !== "ok" && check.status !== "unknown_type") {
        failures.push(
          `${event.eventName}: ${check.ref.objectType}/${check.ref.objectId} ${check.status}${check.detail !== undefined ? `:${check.detail}` : ""}`,
        );
      }
    }
    return { timestamp: event.timestamp, eventName: event.eventName, outcome: event.outcome, refs };
  });

  const run = snapshot.entities.runs[input.productRunId as never];
  let gitSha = "unknown";
  try {
    gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: input.repoRoot ?? process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    failures.push("版本证据缺失：无法解析Git SHA");
  }

  return {
    productRunId: input.productRunId,
    gitSha,
    workflowDefinitionVersions: [...workflowVersions],
    promptTemplateVersions: [...promptVersions],
    modelConfigVersions: [...modelVersions],
    run:
      run !== undefined ? { status: run.status, phase: run.phase, revision: run.revision } : null,
    timeline,
    failures,
  };
}

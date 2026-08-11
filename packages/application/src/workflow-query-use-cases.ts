import {
  workflowNodeDetailDtoSchema,
  workflowRunViewDtoSchema,
  type NodeProductRef,
  type PrincipalId,
  type ProductSnapshot,
  type ProductRunId,
  type WorkflowNodeDetailDto,
  type WorkflowNodeDetailInclude,
  type WorkflowNodeRun,
  type WorkflowNodeRunId,
  type WorkflowNodeRunSummaryDto,
  type WorkflowRunViewDto,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { notFound } from "./errors.js";

interface QueryEnvelope<T> {
  readonly value: T;
  readonly etag: string;
}

function loadAuthorizedRun(
  snapshot: ProductSnapshot,
  productRunId: ProductRunId,
  principalId: PrincipalId,
) {
  const run = snapshot.entities.runs[productRunId];
  const session = run === undefined ? undefined : snapshot.entities.sessions[run.sessionId];
  // Workflow查询统一404，避免Node/Run枚举泄露其他Principal的对象存在性。
  if (run === undefined || session?.ownerPrincipalId !== principalId) {
    throw notFound("Workflow Run不存在");
  }
  const view = snapshot.entities.workflowViewDefinitions[run.workflowViewDefinitionId];
  if (view === undefined) throw notFound("Workflow View不存在");
  return { run, view };
}

function allowedActions(
  snapshot: ProductSnapshot,
  nodeRun: WorkflowNodeRun,
  now: string,
): WorkflowNodeRunSummaryDto["allowedActions"] {
  if (nodeRun.status !== "waiting_human") return ["inspect"];
  if (nodeRun.nodeType === "human.plan_review") {
    const approval = Object.values(snapshot.entities.approvalRequests).find(
      (candidate) =>
        candidate.productRunId === nodeRun.productRunId &&
        candidate.planRevision === nodeRun.executionPath.at(-1)?.iteration,
    );
    return approval?.status === "open" && Date.parse(now) < Date.parse(approval.expiresAt)
      ? ["inspect", "submit_decision"]
      : ["inspect"];
  }
  if (nodeRun.nodeType !== "human.note_review" || nodeRun.inputManifestId === undefined) {
    return ["inspect"];
  }
  // Note审核没有Approval聚合；操作权限必须绑定该Node冻结输入Manifest中的精确Candidate，
  // 不能仅凭Run处于waiting_human就让浏览器对任意或已结束Candidate提交决定。
  const manifest = snapshot.entities.nodeValueManifests[nodeRun.inputManifestId];
  const candidateRef = manifest?.slots
    .flatMap((slot) => slot.refs)
    .find((ref) => ref.kind === "note_candidate");
  const candidate =
    candidateRef === undefined ? undefined : snapshot.entities.noteCandidates[candidateRef.id];
  return candidate !== undefined &&
    candidate.productRunId === nodeRun.productRunId &&
    candidate.revision === candidateRef?.revision &&
    candidate.sha256 === candidateRef.sha256 &&
    candidate.status === "under_review"
    ? ["inspect", "submit_decision"]
    : ["inspect"];
}

function toNodeSummary(
  snapshot: ProductSnapshot,
  nodeRun: WorkflowNodeRun,
  now: string,
): WorkflowNodeRunSummaryDto {
  const view = snapshot.entities.workflowViewDefinitions[nodeRun.workflowViewDefinitionId];
  const definition = view?.nodes.find(
    (candidate) => candidate.definitionNodeId === nodeRun.definitionNodeId,
  );
  const dynamicExecutionChild = nodeRun.nodeType === "execute.plan_step";
  return {
    workflowNodeRunId: nodeRun.workflowNodeRunId,
    definitionNodeId: nodeRun.definitionNodeId,
    nodeType: nodeRun.nodeType,
    title:
      definition?.title ??
      (dynamicExecutionChild
        ? (nodeRun.publicSummary?.replace(/：已完成$/u, "") ?? "执行步骤")
        : "节点"),
    kind: definition?.kind ?? "task",
    optional: definition?.optional ?? false,
    executionPath: nodeRun.executionPath.map((segment) => ({ ...segment })),
    attemptNumber: nodeRun.attemptNumber,
    ...(nodeRun.parentNodeRunId !== undefined ? { parentNodeRunId: nodeRun.parentNodeRunId } : {}),
    status: nodeRun.status,
    ...(nodeRun.outcomeCode !== undefined ? { outcomeCode: nodeRun.outcomeCode } : {}),
    ...(nodeRun.publicSummary !== undefined ? { publicSummary: nodeRun.publicSummary } : {}),
    ...(nodeRun.error !== undefined ? { error: { ...nodeRun.error } } : {}),
    ...(nodeRun.startedAt !== undefined ? { startedAt: nodeRun.startedAt } : {}),
    ...(nodeRun.finishedAt !== undefined ? { finishedAt: nodeRun.finishedAt } : {}),
    ...(nodeRun.durationMs !== undefined ? { durationMs: nodeRun.durationMs } : {}),
    revision: nodeRun.revision,
    updatedAt: nodeRun.updatedAt,
    allowedActions: allowedActions(snapshot, nodeRun, now),
  };
}

function nodeSortKey(
  definitionOrder: ReadonlyMap<string, number>,
  nodeRun: WorkflowNodeRun,
): string {
  const order = definitionOrder.get(nodeRun.definitionNodeId) ?? 999;
  const path = nodeRun.executionPath
    .map((segment) => `${segment.containerNodeId}:${String(segment.iteration).padStart(3, "0")}`)
    .join("/");
  return `${String(order).padStart(3, "0")}:${path}:${nodeRun.parentNodeRunId === undefined ? "0" : "1"}:${nodeRun.definitionNodeId}:${String(nodeRun.attemptNumber).padStart(3, "0")}`;
}

function relevantRevision(
  runRevision: number,
  nodeRuns: readonly WorkflowNodeRun[],
  snapshot: ProductSnapshot,
): number {
  let revision = runRevision + 1;
  for (const nodeRun of nodeRuns) {
    revision += nodeRun.revision;
    const input =
      nodeRun.inputManifestId === undefined
        ? undefined
        : snapshot.entities.nodeValueManifests[nodeRun.inputManifestId];
    const output =
      nodeRun.outputManifestId === undefined
        ? undefined
        : snapshot.entities.nodeValueManifests[nodeRun.outputManifestId];
    revision += (input?.revision ?? 0) + (output?.revision ?? 0);
    revision += Object.values(snapshot.entities.nodeRunTransitions).filter(
      (transition) => transition.workflowNodeRunId === nodeRun.workflowNodeRunId,
    ).length;
  }
  return revision;
}

function latestUpdatedAt(values: readonly string[]): string {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

export async function getWorkflowRunView(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
): Promise<QueryEnvelope<WorkflowRunViewDto>> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const { run, view } = loadAuthorizedRun(snapshot, input.productRunId, input.principalId);
  const definitionOrder = new Map(
    view.nodes.map((node, index) => [node.definitionNodeId, index] as const),
  );
  const nodeRuns = Object.values(snapshot.entities.workflowNodeRuns)
    .filter((nodeRun) => nodeRun.productRunId === input.productRunId)
    .sort((left, right) =>
      nodeSortKey(definitionOrder, left).localeCompare(nodeSortKey(definitionOrder, right)),
    );
  const value = workflowRunViewDtoSchema.parse({
    schemaVersion: "chat-workflow-api.v1",
    productRunId: run.productRunId,
    workflowViewDefinitionId: view.workflowViewDefinitionId,
    title: view.title,
    viewHash: view.sha256,
    sourceKind: view.source.kind,
    historyCompleteness: nodeRuns.some(
      (nodeRun) => nodeRun.projectionSource === "legacy_product_facts",
    )
      ? "legacy_limited"
      : "complete",
    definitionNodes: view.nodes.map((node) => ({ ...node })),
    edges: view.edges.map((edge) => ({ ...edge })),
    nodeRuns: nodeRuns.map((nodeRun) => toNodeSummary(snapshot, nodeRun, deps.now())),
    revision: relevantRevision(run.revision, nodeRuns, snapshot),
    updatedAt: latestUpdatedAt([
      run.updatedAt,
      view.updatedAt,
      ...nodeRuns.map((item) => item.updatedAt),
    ]),
    allowedActions: ["inspect_nodes"],
  });
  return {
    value,
    etag: `"${hashCanonical("workflow-run-view-etag.v1", value)}"`,
  };
}

function manifestDto(
  snapshot: ProductSnapshot,
  manifestId: string | undefined,
): WorkflowNodeDetailDto["input"] {
  if (manifestId === undefined) return undefined;
  const manifest = snapshot.entities.nodeValueManifests[manifestId];
  return manifest === undefined
    ? undefined
    : {
        direction: manifest.direction,
        slots: manifest.slots.map((slot) => ({
          name: slot.name,
          refs: slot.refs.map((ref) => ({ ...ref })),
        })),
        sha256: manifest.sha256,
        revision: manifest.revision,
      };
}

function uniqueEvidence(refs: readonly NodeProductRef[]): NodeProductRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}:${String(ref.revision)}:${ref.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getWorkflowNodeDetail(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly productRunId: ProductRunId;
    readonly workflowNodeRunId: WorkflowNodeRunId;
    readonly include?: readonly WorkflowNodeDetailInclude[] | undefined;
  },
): Promise<QueryEnvelope<WorkflowNodeDetailDto>> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const { run, view } = loadAuthorizedRun(snapshot, input.productRunId, input.principalId);
  const nodeRun = snapshot.entities.workflowNodeRuns[input.workflowNodeRunId];
  if (nodeRun?.productRunId !== run.productRunId) throw notFound("Workflow Node不存在");
  const includes = new Set(input.include ?? ["summary", "manifests", "timeline", "evidence"]);
  const inputManifest = manifestDto(snapshot, nodeRun.inputManifestId);
  const outputManifest = manifestDto(snapshot, nodeRun.outputManifestId);
  const transitions = Object.values(snapshot.entities.nodeRunTransitions)
    .filter((transition) => transition.workflowNodeRunId === nodeRun.workflowNodeRunId)
    .sort((left, right) => left.nodeSequence - right.nodeSequence);
  const evidence = uniqueEvidence([
    ...(inputManifest?.slots.flatMap((slot) => slot.refs) ?? []),
    ...(outputManifest?.slots.flatMap((slot) => slot.refs) ?? []),
    ...transitions.flatMap((transition) =>
      transition.relatedProductRef === undefined ? [] : [transition.relatedProductRef],
    ),
  ]);
  const revision = relevantRevision(run.revision, [nodeRun], snapshot);
  const value = workflowNodeDetailDtoSchema.parse({
    schemaVersion: "chat-workflow-api.v1",
    productRunId: run.productRunId,
    viewHash: view.sha256,
    node: toNodeSummary(snapshot, nodeRun, deps.now()),
    ...(includes.has("manifests") && inputManifest !== undefined ? { input: inputManifest } : {}),
    ...(includes.has("manifests") && outputManifest !== undefined
      ? { output: outputManifest }
      : {}),
    ...(includes.has("timeline")
      ? {
          timeline: transitions.map((transition) => ({
            nodeSequence: transition.nodeSequence,
            ...(transition.fromStatus !== undefined ? { fromStatus: transition.fromStatus } : {}),
            toStatus: transition.toStatus,
            reasonKind: transition.reasonKind,
            ...(transition.relatedProductRef !== undefined
              ? { relatedProductRef: { ...transition.relatedProductRef } }
              : {}),
            occurredAt: transition.occurredAt,
          })),
        }
      : {}),
    ...(includes.has("evidence") ? { evidence } : {}),
    revision,
    updatedAt: latestUpdatedAt([
      nodeRun.updatedAt,
      ...transitions.map((transition) => transition.updatedAt),
      ...(inputManifest === undefined
        ? []
        : [
            snapshot.entities.nodeValueManifests[nodeRun.inputManifestId ?? ""]?.updatedAt ??
              nodeRun.updatedAt,
          ]),
      ...(outputManifest === undefined
        ? []
        : [
            snapshot.entities.nodeValueManifests[nodeRun.outputManifestId ?? ""]?.updatedAt ??
              nodeRun.updatedAt,
          ]),
    ]),
  });
  return {
    value,
    etag: `"${hashCanonical("workflow-node-detail-etag.v1", value)}"`,
  };
}

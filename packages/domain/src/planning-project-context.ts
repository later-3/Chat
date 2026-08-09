import { hashCanonical } from "./canonical-hash.js";

interface PlanningProjectSourceRef {
  readonly kind: "project" | "method" | "stage" | "milestone" | "update" | "work" | "action";
  readonly objectId: string;
  readonly revision: number;
  readonly sha256: string;
}

export interface PlanningProjectContextHashInput {
  readonly productRunId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly projectSha256: string;
  readonly methodRef: {
    readonly projectMethodSnapshotId: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly stageRef: {
    readonly projectStageId: string;
    readonly revision: number;
    readonly sha256: string;
  };
  readonly snapshot: unknown;
  readonly sourceRefs: readonly PlanningProjectSourceRef[];
}

export interface PlanningProjectContextShape extends PlanningProjectContextHashInput {
  readonly schemaVersion: string;
  readonly planningProjectContextId: string;
  readonly sha256: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Hash覆盖冻结正文与全部来源引用；时间和对象ID不参与，便于幂等重建后验证语义一致。 */
export function computePlanningProjectContextSha256(
  input: PlanningProjectContextHashInput,
): string {
  return hashCanonical("planning-project-context.v1", {
    productRunId: input.productRunId,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    projectSha256: input.projectSha256,
    methodRef: input.methodRef,
    stageRef: input.stageRef,
    snapshot: input.snapshot,
    sourceRefs: [...input.sourceRefs].sort((left, right) =>
      `${left.kind}:${left.objectId}`.localeCompare(`${right.kind}:${right.objectId}`),
    ),
  });
}

export function assertPlanningProjectContextIntegrity(context: PlanningProjectContextShape): void {
  if (context.updatedAt !== context.createdAt) {
    throw new Error("Planning Project Context冻结后不可更新");
  }
  const keys = context.sourceRefs.map((ref) => `${ref.kind}:${ref.objectId}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Planning Project Context来源引用不能重复");
  }
  const required = [
    `project:${context.projectId}`,
    `method:${context.methodRef.projectMethodSnapshotId}`,
    `stage:${context.stageRef.projectStageId}`,
  ];
  if (required.some((key) => !keys.includes(key))) {
    throw new Error("Planning Project Context缺少Project/Method/Stage来源引用");
  }
  const methodSource = context.sourceRefs.find(
    (ref) => ref.kind === "method" && ref.objectId === context.methodRef.projectMethodSnapshotId,
  );
  const stageSource = context.sourceRefs.find(
    (ref) => ref.kind === "stage" && ref.objectId === context.stageRef.projectStageId,
  );
  if (
    methodSource === undefined ||
    methodSource.revision !== context.methodRef.revision ||
    methodSource.sha256 !== context.methodRef.sha256 ||
    stageSource === undefined ||
    stageSource.revision !== context.stageRef.revision ||
    stageSource.sha256 !== context.stageRef.sha256
  ) {
    throw new Error("Planning Project Context Method/Stage来源三元组不一致");
  }
  if (computePlanningProjectContextSha256(context) !== context.sha256) {
    throw new Error("Planning Project Context Hash不匹配");
  }
}

/** 来源对象仍处于同一revision时校验精确内容；后续revision不会倒灌旧Context。 */
export function computePlanningProjectSourceRefSha256(input: {
  readonly kind: PlanningProjectContextShape["sourceRefs"][number]["kind"];
  readonly entity: object;
}): string {
  return hashCanonical("planning-project-source-ref.v1", input);
}

/** RunSpec与Project Context共同冻结的Project聚合资源Hash。 */
export function computeWorkflowProjectResourceSha256(project: {
  readonly projectId: string;
  readonly revision: number;
  readonly updatedAt: string;
}): string {
  return hashCanonical("workflow-project-ref.v1", {
    projectId: project.projectId,
    revision: project.revision,
    updatedAt: project.updatedAt,
  });
}

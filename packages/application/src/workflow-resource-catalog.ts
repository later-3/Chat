import type {
  PrincipalId,
  ProductSnapshot,
  WorkflowFrozenResource,
  WorkflowResourceRefDto,
  WorkflowRunConfiguration,
} from "@chat/contracts";
import { PRODUCT_API_SCHEMA_VERSION } from "@chat/contracts";
import { ApplicationError, forbidden } from "./errors.js";

export interface AuthorizedWorkflowResource {
  readonly frozen: WorkflowFrozenResource & {
    readonly resourceKind: "memory" | "rule" | "skill";
  };
  readonly label: string;
  readonly source: string;
}

/**
 * Workflow资源目录只从有权读取的产品事实构建。Memory Snapshot本身没有owner字段，
 * 必须沿 Query→Run→Session反查；仅凭知道mrs_* ID或Hash绝不构成授权。
 */
export function listAuthorizedWorkflowResources(
  snapshot: ProductSnapshot,
  principalId: PrincipalId,
): readonly AuthorizedWorkflowResource[] {
  const resources: AuthorizedWorkflowResource[] = [];
  for (const memory of Object.values(snapshot.entities.memoryResultSnapshots)) {
    const query = snapshot.entities.memoryQueries[memory.memoryQueryId];
    const run = query === undefined ? undefined : snapshot.entities.runs[query.productRunId];
    const session = run === undefined ? undefined : snapshot.entities.sessions[run.sessionId];
    if (session?.ownerPrincipalId !== principalId) continue;
    resources.push({
      frozen: {
        resourceKind: "memory",
        resourceId: memory.memoryResultSnapshotId,
        revision: memory.revision,
        sha256: memory.sha256,
        status: "active",
        allowedPrincipalIds: [principalId],
      },
      label: memory.title,
      source: memory.backendId,
    });
  }
  for (const rule of Object.values(snapshot.entities.rules)) {
    if (
      rule.ownerPrincipalId !== principalId ||
      (rule.lifecycle !== "active" && rule.lifecycle !== "trial")
    ) {
      continue;
    }
    const revision = snapshot.entities.ruleRevisions[rule.currentRevisionId];
    if (revision === undefined) continue;
    resources.push({
      frozen: {
        resourceKind: "rule",
        resourceId: rule.ruleId,
        revision: revision.revision,
        sha256: revision.sha256,
        status: "active",
        allowedPrincipalIds: [rule.ownerPrincipalId],
      },
      label: rule.title,
      source: `rule:${rule.lifecycle}`,
    });
  }
  return resources.sort((left, right) =>
    `${left.frozen.resourceKind}:${left.frozen.resourceId}`.localeCompare(
      `${right.frozen.resourceKind}:${right.frozen.resourceId}`,
    ),
  );
}

export function toWorkflowResourceRefDto(
  resource: AuthorizedWorkflowResource,
): WorkflowResourceRefDto {
  return {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    resourceKind: resource.frozen.resourceKind,
    resourceId: resource.frozen.resourceId,
    revision: resource.frozen.revision,
    sha256: resource.frozen.sha256,
    status: resource.frozen.status,
    label: resource.label,
    source: resource.source,
  };
}

/**
 * 浏览器显式提交的资源ID先在产品权限边界解析，再交给Compiler冻结revision/hash。
 * 不可读资源不能以excluded ref混入RunSpec；首次预检与提交事务内都调用本函数，
 * 因而权限或存在性在两次读取之间变化时仍然零写入失败。
 */
export function assertWorkflowResourceSelectionsAuthorized(
  snapshot: ProductSnapshot,
  principalId: PrincipalId,
  configuration: WorkflowRunConfiguration,
): void {
  const authorized = new Set(
    listAuthorizedWorkflowResources(snapshot, principalId).map(
      (resource) => `${resource.frozen.resourceKind}\0${resource.frozen.resourceId}`,
    ),
  );
  for (const override of configuration.overrides) {
    if (override.kind !== "resource_selection") continue;
    if (override.resourceKind === "project") {
      throw new ApplicationError({
        code: "resource_stale",
        httpStatus: 409,
        message: "Project资源已退出当前产品",
        recoveryAction: "rehydrate_and_retry",
      });
    }
    for (const selection of override.selections) {
      const key = `${override.resourceKind}\0${selection.resourceId}`;
      if (authorized.has(key)) continue;
      const ownerPrincipalId = workflowResourceOwnerPrincipalId(
        snapshot,
        override.resourceKind,
        selection.resourceId,
      );
      if (ownerPrincipalId !== undefined && ownerPrincipalId !== principalId) {
        throw forbidden("无权使用该Workflow资源");
      }
      throw new ApplicationError({
        code: "resource_stale",
        httpStatus: 409,
        message: "Workflow资源不存在或已变化",
        recoveryAction: "rehydrate_and_retry",
      });
    }
  }
}

function workflowResourceOwnerPrincipalId(
  snapshot: ProductSnapshot,
  kind: "memory" | "rule" | "skill",
  resourceId: string,
): PrincipalId | undefined {
  if (kind === "memory") {
    const memory = snapshot.entities.memoryResultSnapshots[resourceId];
    const query =
      memory === undefined ? undefined : snapshot.entities.memoryQueries[memory.memoryQueryId];
    const run = query === undefined ? undefined : snapshot.entities.runs[query.productRunId];
    return run === undefined
      ? undefined
      : snapshot.entities.sessions[run.sessionId]?.ownerPrincipalId;
  }
  if (kind === "rule") return snapshot.entities.rules[resourceId]?.ownerPrincipalId;
  // Skill持久集合尚未接入；未知skill ID必须失败关闭。
  return undefined;
}

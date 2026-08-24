import type {
  CommandId,
  PlaneCeProjectId,
  ProjectBootstrapProposal,
  ProjectBootstrapOperationId,
} from "@chat/contracts";

/**
 * 当前Product Store是单API进程、单写者；本协调器把同一Operation从claim到Provider
 * 收口串行化。旧执行者只要仍可能恢复就继续持有互斥，进程崩溃后锁随进程释放。
 * 未来若Product Store升级为多进程数据库，本Port必须替换为数据库advisory lock。
 */
export interface ProjectBootstrapExecutionCoordinatorPort {
  runExclusive<T>(operationId: ProjectBootstrapOperationId, execute: () => Promise<T>): Promise<T>;
}

/** Provider必须在每一个真实写边界前调用assertCurrent；token同时进入Adapter合同。 */
export interface ProjectBootstrapWriteFence {
  readonly attemptCommandId: CommandId;
  readonly fencingToken: number;
  assertCurrent(writeKey: string): Promise<void>;
}

export function createInProcessProjectBootstrapExecutionCoordinator(): ProjectBootstrapExecutionCoordinatorPort {
  const tails = new Map<ProjectBootstrapOperationId, Promise<void>>();
  return {
    async runExclusive<T>(operationId: ProjectBootstrapOperationId, execute: () => Promise<T>) {
      const prior = tails.get(operationId) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.then(() => held);
      tails.set(operationId, tail);
      await prior;
      try {
        return await execute();
      } finally {
        release();
        if (tails.get(operationId) === tail) tails.delete(operationId);
      }
    },
  };
}

export interface ProjectCreationRootDescriptor {
  readonly rootId: ProjectBootstrapProposal["workspaceRootId"];
  readonly displayName: string;
}

export interface ProjectWorkspacePreflight {
  readonly root: ProjectCreationRootDescriptor;
  readonly directoryName: string;
  readonly workspaceLabel: string;
}

export type ProjectWorkspaceProvisionResult =
  | { readonly status: "completed"; readonly workspaceLabel: string }
  | { readonly status: "failed"; readonly errorCode: string }
  | { readonly status: "outcome_unknown"; readonly errorCode: string };

/** 文件系统正文仍由本机目录/Git拥有；Application只保存rootId+相对目录绑定。 */
export interface ProjectWorkspaceProvisionerPort {
  listRoots(): readonly ProjectCreationRootDescriptor[];
  preflight(input: {
    readonly rootId: ProjectBootstrapProposal["workspaceRootId"];
    readonly directoryName: string;
  }): Promise<ProjectWorkspacePreflight>;
  provision(input: {
    readonly operationId: ProjectBootstrapOperationId;
    readonly candidateSha256: string;
    readonly proposal: ProjectBootstrapProposal;
    readonly writeFence: ProjectBootstrapWriteFence;
  }): Promise<ProjectWorkspaceProvisionResult>;
  reconcile(input: {
    readonly operationId: ProjectBootstrapOperationId;
    readonly candidateSha256: string;
    readonly proposal: ProjectBootstrapProposal;
  }): Promise<ProjectWorkspaceProvisionResult>;
}

export interface ProjectManagementPreflight {
  readonly planeProjectLabel: string;
}

export type ProjectManagementProvisionResult =
  | { readonly status: "completed"; readonly planeProjectId: PlaneCeProjectId }
  | { readonly status: "failed"; readonly errorCode: string }
  | { readonly status: "outcome_unknown"; readonly errorCode: string }
  | {
      readonly status: "needs_attention";
      readonly errorCode: string;
      readonly planeProjectId?: PlaneCeProjectId;
    };

/** Plane CE Adapter拥有REST差异；Application只消费“预检/初始化/只读对账”稳定语义。 */
export interface ProjectManagementBootstrapPort {
  describe(): {
    readonly providerKind: "plane_ce";
    readonly providerVersion: string;
    readonly providerWebBaseUrl: string;
    readonly allowedWorkspaceSlugs: readonly string[];
  };
  preflight(input: {
    readonly workspaceSlug: string;
    readonly projectIdentifier: string;
    readonly projectName: string;
  }): Promise<ProjectManagementPreflight>;
  provision(input: {
    readonly operationId: ProjectBootstrapOperationId;
    readonly candidateSha256: string;
    readonly proposal: ProjectBootstrapProposal;
    readonly writeFence: ProjectBootstrapWriteFence;
  }): Promise<ProjectManagementProvisionResult>;
  reconcile(input: {
    readonly operationId: ProjectBootstrapOperationId;
    readonly candidateSha256: string;
    readonly proposal: ProjectBootstrapProposal;
  }): Promise<ProjectManagementProvisionResult>;
}

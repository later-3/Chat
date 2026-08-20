import type {
  PlaneCeProjectId,
  ProjectBootstrapProposal,
  ProjectBootstrapOperationId,
} from "@chat/contracts";

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
  }): Promise<ProjectManagementProvisionResult>;
  reconcile(input: {
    readonly operationId: ProjectBootstrapOperationId;
    readonly candidateSha256: string;
    readonly proposal: ProjectBootstrapProposal;
  }): Promise<ProjectManagementProvisionResult>;
}

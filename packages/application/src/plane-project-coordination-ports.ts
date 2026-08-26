import type {
  PlaneProjectBinding,
  PlaneProjectOperationIntent,
  PlaneProjectSnapshot,
} from "@chat/contracts";

/**
 * Plane CE 仍拥有 Project、Module、State、Work Item 与 Comment；Application 只消费
 * 受管读写语义。Provider 原始响应、Token、Base URL 和任意 REST 能力都不能越过此 Port。
 */
export interface PlaneProjectCoordinationPort {
  describe(): {
    readonly providerKind: "plane_ce";
    readonly providerVersion: string;
    readonly allowedWorkspaceSlugs: readonly string[];
    readonly externalSource: "later-agent";
  };

  findProjectByIdentifier(input: {
    readonly workspaceSlug: string;
    readonly projectIdentifier: string;
  }): Promise<PlaneProviderProject | undefined>;

  readProjectSnapshot(input: {
    readonly workspaceSlug: string;
    readonly projectId: string;
  }): Promise<PlaneProviderProjectSnapshot>;

  readWorkItemComments(input: {
    readonly workspaceSlug: string;
    readonly projectId: string;
    readonly workItemId: string;
    readonly workItemExternalId: string;
    readonly limit: number;
  }): Promise<PlaneProviderCommentPage>;

  ensureWorkItem(input: PlaneProviderEnsureWorkItemIntent): Promise<PlaneProviderWorkItemResult>;
  reconcileEnsureWorkItem(
    input: PlaneProviderEnsureWorkItemIntent,
  ): Promise<PlaneProviderWorkItemResult>;

  transitionWorkItemState(
    input: PlaneProviderTransitionIntent,
  ): Promise<PlaneProviderWorkItemResult>;
  /** 复合“评论→状态”动作在评论POST前执行的只读State/身份/来源检查。 */
  preflightWorkItemStateTransition(
    input: PlaneProviderTransitionIntent,
  ): Promise<PlaneProviderWorkItemResult>;
  /** 同一Provider lease内完成preflight→comment→state，串行同Work Item的Agent复合写。 */
  applyCommentedWorkItemStateTransition(input: {
    readonly transition: PlaneProviderTransitionIntent;
    readonly comment: PlaneProviderCommentIntent;
  }): Promise<PlaneProviderCommentedTransitionResult>;
  reconcileWorkItemStateTransition(
    input: PlaneProviderTransitionIntent,
  ): Promise<PlaneProviderWorkItemResult>;

  appendWorkItemComment(input: PlaneProviderCommentIntent): Promise<PlaneProviderCommentResult>;
  reconcileWorkItemComment(input: PlaneProviderCommentIntent): Promise<PlaneProviderCommentResult>;
}

export interface PlaneProviderProject {
  readonly id: string;
  readonly name: string;
  readonly identifier: string;
}

export interface PlaneProviderProjectSnapshot {
  readonly project: PlaneProviderProject;
  readonly states: readonly {
    readonly id: string;
    readonly name: string;
    readonly group: PlaneProjectSnapshot["states"][number]["group"];
  }[];
  readonly modules: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: PlaneProjectSnapshot["modules"][number]["status"];
    readonly totalWorkItems: number;
    readonly completedWorkItems: number;
    readonly cancelledWorkItems: number;
    readonly startedWorkItems: number;
    readonly unstartedWorkItems: number;
    readonly backlogWorkItems: number;
  }[];
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }[];
  /** Provider可以返回全部活动项；Application负责公开DTO的500项上限与truncated标记。 */
  readonly workItems: readonly PlaneProviderWorkItem[];
}

export interface PlaneProviderWorkItem {
  readonly id: string;
  readonly sequenceId: number;
  readonly name: string;
  readonly description?: string | undefined;
  readonly priority: PlaneProjectSnapshot["workItems"][number]["priority"];
  readonly moduleIds: readonly string[];
  readonly labelIds: readonly string[];
  readonly stateId: string;
  readonly stateName?: string | undefined;
  readonly stateGroup?: PlaneProjectSnapshot["states"][number]["group"] | undefined;
  readonly externalSource?: string | undefined;
  readonly externalId?: string | undefined;
  readonly updatedAt: string;
  readonly updatedById?: string | undefined;
}

export interface PlaneProviderComment {
  readonly id: string;
  readonly workItemId: string;
}

export interface PlaneProviderCommentPage {
  readonly comments: readonly {
    readonly id: string;
    readonly workItemId: string;
    readonly excerpt: string;
    readonly origin: "later_agent" | "human_or_other";
    readonly actorExternalId?: string | undefined;
    readonly externalId?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly updatedAt?: string | undefined;
  }[];
  readonly totalCommentCount: number;
  readonly truncated: boolean;
}

type BindingLocation = Pick<PlaneProjectBinding, "planeWorkspaceSlug" | "planeProjectId">;

export interface PlaneProviderEnsureWorkItemIntent extends BindingLocation {
  readonly externalId: string;
  readonly name: string;
  readonly description: string;
  readonly priority: Extract<PlaneProjectOperationIntent, { kind: "ensure_work_item" }>["priority"];
  readonly stateName: string;
  readonly stateGroup: "backlog" | "unstarted" | "started";
  readonly moduleIds: readonly string[];
  readonly labelIds: readonly string[];
}

export interface PlaneProviderTransitionIntent extends BindingLocation {
  readonly workItemId: string;
  readonly workItemExternalId: string;
  /** Provider在PATCH前精确比较；不匹配表示人或其他执行者已更新，必须停止。 */
  readonly expectedStateId: string;
  readonly stateName: string;
  readonly stateGroup: "started";
  readonly labelIds?: readonly string[] | undefined;
  readonly managedLabelIds?: readonly string[] | undefined;
}

export interface PlaneProviderCommentIntent extends BindingLocation {
  readonly workItemId: string;
  readonly workItemExternalId: string;
  readonly kind: "progress" | "block" | "request_review" | "evidence";
  readonly commentExternalId: string;
  readonly commentHtml: string;
}

export type PlaneProviderWorkItemResult =
  | { readonly status: "completed"; readonly workItem: PlaneProviderWorkItem }
  | {
      readonly status: "failed" | "needs_attention" | "outcome_unknown";
      readonly errorCode: string;
      readonly workItem?: PlaneProviderWorkItem | undefined;
    };

export type PlaneProviderCommentResult =
  | { readonly status: "completed"; readonly comment: PlaneProviderComment }
  | {
      readonly status: "failed" | "needs_attention" | "outcome_unknown";
      readonly errorCode: string;
      readonly comment?: PlaneProviderComment | undefined;
    };

export type PlaneProviderCommentedTransitionResult =
  | { readonly phase: "preflight"; readonly outcome: PlaneProviderWorkItemResult }
  | { readonly phase: "comment"; readonly outcome: PlaneProviderCommentResult }
  | {
      readonly phase: "transition";
      readonly comment: PlaneProviderComment;
      readonly outcome: PlaneProviderWorkItemResult;
    };

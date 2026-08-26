export interface PlaneProjectRolloutInspectionPort {
  describe(): {
    readonly providerKind: "plane_ce";
    readonly providerVersion: "1.4.1";
    readonly allowedWorkspaceSlugs: readonly string[];
  };

  /**
   * P8管理员Dry Run只读完整Project配置。这里没有任何写方法，也不复用Agent日常工具；
   * 返回值只保留差异计算所需字段，不暴露Token、成员邮箱或任意Provider payload。
   */
  inspectProject(input: {
    readonly workspaceSlug: string;
    readonly projectIdentifier: string;
  }): Promise<PlaneProjectRolloutInspection>;
}

export interface PlaneProjectRolloutExecutionPort {
  describe(): {
    readonly providerKind: "plane_ce";
    readonly providerVersion: "1.4.1";
    readonly allowedWorkspaceSlugs: readonly string[];
  };

  /**
   * 一次性管理员纵向只接受Application由获批Dry Run重新物化的固定对象。
   * Port没有View/Page/Intake、删除、归档或任意HTTP能力；Provider必须逐对象预检、写后回读，
   * 对响应未知只允许查询对账，不能盲重试原写。
   */
  executeApprovedRollout(
    input: PlaneProjectRolloutExecutionIntent,
  ): Promise<PlaneProjectRolloutExecutionOutcome>;
}

export interface PlaneProjectRolloutExecutionIntent {
  readonly workspaceSlug: string;
  readonly projectId: string;
  readonly approvedDryRunSha256: string;
  readonly project: {
    readonly stableKey: "project:content-lab";
    readonly displayName: string;
    readonly description: string;
    readonly network: 0 | 2;
    readonly moduleView: true;
    readonly cycleView: false;
    readonly issueViewsView: false;
    readonly pageView: true;
    readonly intakeView: false;
  };
  readonly states: readonly {
    readonly stableKey: string;
    readonly name: string;
    readonly group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
    readonly color: string;
    readonly sequence: number;
  }[];
  readonly modules: readonly {
    readonly stableKey: string;
    readonly name: string;
    readonly description: string;
    readonly externalId: string;
  }[];
  readonly labels: readonly {
    readonly stableKey: string;
    readonly name: string;
    readonly color: string;
    readonly externalId: string;
  }[];
  readonly workItems: readonly {
    readonly targetKind: "history_work" | "workflow_improvement";
    readonly stableKey: string;
    readonly name: string;
    readonly description: string;
    readonly externalId: string;
    readonly stateName: "Intake" | "Proposed" | "Needs Review" | "Ready" | "Blocked";
    readonly stateGroup: "backlog" | "started";
    readonly moduleName: string;
    readonly labelNames: readonly string[];
    readonly priority: "medium";
  }[];
}

export interface PlaneProjectRolloutExecutionOutcome {
  readonly objects: readonly {
    readonly targetKind:
      | "project_configuration"
      | "state"
      | "module"
      | "label"
      | "history_work"
      | "workflow_improvement";
    readonly stableKey: string;
    readonly displayName: string;
    readonly externalId?: string | undefined;
    readonly providerObjectId: string;
    readonly outcome: "created" | "updated" | "reused";
  }[];
  readonly writes: number;
}

export interface PlaneProjectRolloutInspection {
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly identifier: string;
    readonly description: string;
    readonly network: number;
    readonly moduleView: boolean;
    readonly cycleView: boolean;
    readonly issueViewsView: boolean;
    readonly pageView: boolean;
    readonly intakeView: boolean;
  };
  readonly states: readonly {
    readonly id: string;
    readonly name: string;
    readonly group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
    readonly color: string;
    readonly sequence: number;
  }[];
  readonly surfaceAvailability: {
    readonly views: "available" | "unavailable";
    readonly pages: "available" | "unavailable";
    readonly intakes: "available" | "unavailable";
  };
  readonly modules: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly externalSource?: string | undefined;
    readonly externalId?: string | undefined;
  }[];
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }[];
  readonly views: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly filtersJson: string;
    readonly displayFiltersJson: string;
    readonly archived: boolean;
  }[];
  readonly pages: readonly {
    readonly id: string;
    readonly name: string;
    readonly access: number;
    readonly locked: boolean;
    readonly archived: boolean;
    readonly externalSource?: string | undefined;
    readonly externalId?: string | undefined;
  }[];
  readonly intakes: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly isDefault: boolean;
  }[];
  readonly workItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly externalSource?: string | undefined;
    readonly externalId?: string | undefined;
  }[];
}

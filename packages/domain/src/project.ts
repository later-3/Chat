import { hashCanonical } from "./canonical-hash.js";

export interface ProjectMethodPolicyShape {
  shaping: boolean;
  stagedDelivery: boolean;
  boundedIteration: boolean;
  evidenceRequired: boolean;
}

export interface ProjectIntakeUnderstandingShape {
  name: string;
  goal: string;
  summary: string;
  scopeHints: string[];
  successCriteriaHints: string[];
  initialWorkHints: string[];
  openQuestions: string[];
}

export interface ProjectObservationDataShape {
  git: {
    headSha: string;
    branch: string;
    dirty: boolean;
    trackedFileCount: number;
    recentCommitCount: number;
  };
  documents: { relativePath: string; sha256: string; sizeBytes: number }[];
  scripts: { name: string; command: string }[];
}

export interface ProjectIntakeProposalShape {
  name: string;
  summary: string;
  goal: string;
  scopeIn: string[];
  scopeOut: string[];
  successCriteria: string[];
  method: {
    profileId: "small-project.v1" | "software-delivery.v1" | "lightweight.v1";
    rationale: string;
    policies: ProjectMethodPolicyShape;
  };
  initialStage: { name: string; goal: string };
  initialWork: {
    title: string;
    objective: string;
    acceptanceCriteria: string[];
    firstAction: string;
  }[];
}

export interface ProjectWorkShape {
  projectWorkId: string;
  projectId: string;
  dependsOn: string[];
}

export type ProjectActionStatusShape = "todo" | "doing" | "blocked" | "done" | "cancelled";

const PROJECT_ACTION_TRANSITIONS: Readonly<
  Record<ProjectActionStatusShape, readonly ProjectActionStatusShape[]>
> = {
  todo: ["doing", "blocked", "cancelled"],
  doing: ["blocked", "done", "cancelled"],
  blocked: ["todo", "doing", "cancelled"],
  done: [],
  cancelled: [],
};

/** Action终态不能回退；blocked必须留下可恢复的原因。 */
export function assertProjectActionTransition(input: {
  readonly from: ProjectActionStatusShape;
  readonly to: ProjectActionStatusShape;
  readonly blockedReason?: string;
}): void {
  if (!PROJECT_ACTION_TRANSITIONS[input.from].includes(input.to)) {
    throw new ProjectDomainError(
      "project_action_transition_invalid",
      `Project Action不允许从${input.from}转换到${input.to}`,
    );
  }
  if (input.to === "blocked" && input.blockedReason === undefined) {
    throw new ProjectDomainError("project_action_block_reason_required", "blocked必须说明原因");
  }
  if (input.to !== "blocked" && input.blockedReason !== undefined) {
    throw new ProjectDomainError(
      "project_action_block_reason_invalid",
      "非blocked状态不能保存阻塞原因",
    );
  }
}

const SOFTWARE_POLICIES: ProjectMethodPolicyShape = {
  shaping: true,
  stagedDelivery: true,
  boundedIteration: true,
  evidenceRequired: true,
};

/**
 * 方法建议由可测试的领域规则完成，而不是让模型偷偷决定项目管理方法。
 * PS1只使用真实可观察信号；用户仍可在确认前修改建议。
 */
export function compileProjectIntakeProposal(input: {
  readonly understanding: ProjectIntakeUnderstandingShape;
  readonly observation: ProjectObservationDataShape;
}): ProjectIntakeProposalShape {
  const hasDeliveryScripts = input.observation.scripts.some((script) =>
    /^(build|test|lint|typecheck|check|verify)(:|$)/u.test(script.name),
  );
  const hasProjectDocs = input.observation.documents.some((document) =>
    /(^|\/)(AGENTS|PROJECT_|README|docs\/)/u.test(document.relativePath),
  );
  const profileId =
    hasDeliveryScripts && hasProjectDocs
      ? "software-delivery.v1"
      : input.understanding.initialWorkHints.length <= 3
        ? "lightweight.v1"
        : "small-project.v1";
  const policies: ProjectMethodPolicyShape =
    profileId === "lightweight.v1"
      ? {
          shaping: false,
          stagedDelivery: false,
          boundedIteration: false,
          evidenceRequired: true,
        }
      : SOFTWARE_POLICIES;
  const rationale =
    profileId === "software-delivery.v1"
      ? "观察到真实软件交付脚本和项目文档，采用带Shaping、阶段交付、有限Iteration与证据门的方法。"
      : profileId === "small-project.v1"
        ? "目标包含多个初始工作方向，采用轻量Shaping与有限投入，避免一次展开过多任务。"
        : "当前目标和工作较小，先保留Work、Action、Decision与Evidence，减少不必要流程。";

  return {
    name: input.understanding.name,
    summary: input.understanding.summary,
    goal: input.understanding.goal,
    scopeIn: input.understanding.scopeHints,
    scopeOut: [],
    successCriteria:
      input.understanding.successCriteriaHints.length > 0
        ? input.understanding.successCriteriaHints
        : ["项目目标、真实资源、参与者和下一步能够跨会话恢复"],
    method: { profileId, rationale, policies },
    initialStage: {
      name: profileId === "software-delivery.v1" ? "项目基线" : "启动",
      goal: "建立可验证的项目基线，明确当前工作、责任与下一步。",
    },
    initialWork: input.understanding.initialWorkHints.map((hint) => ({
      title: hint,
      objective: hint,
      acceptanceCriteria: ["产生可验证结果并记录对应Evidence"],
      firstAction: `明确并推进：${hint}`,
    })),
  };
}

export function computeProjectCandidateSha256(input: {
  readonly proposal: ProjectIntakeProposalShape;
  readonly observationSha256: string;
  readonly sourceMessageId: string;
  readonly rootId: string;
  readonly enabledAdapters: readonly string[];
}): string {
  return hashCanonical("project-intake-candidate.v1", input);
}

export function computeProjectManagementCandidateSha256(input: {
  readonly projectId: string;
  readonly boundProjectRevision: number;
  readonly sourceMessageId: string;
  readonly proposal: unknown;
}): string {
  return hashCanonical("project-management-candidate.v1", input);
}

export function computeProjectObservationSha256(data: ProjectObservationDataShape): string {
  return hashCanonical("project-observation.v1", data);
}

export function computeProjectMethodSnapshotSha256(input: {
  readonly profileId: string;
  readonly rationale: string;
  readonly policies: ProjectMethodPolicyShape;
}): string {
  return hashCanonical("project-method-snapshot.v1", input);
}

/** Work依赖必须留在同一Project内且为DAG。 */
export function assertProjectWorkGraph(works: readonly ProjectWorkShape[]): void {
  const byId = new Map(works.map((work) => [work.projectWorkId, work]));
  for (const work of works) {
    for (const dependencyId of work.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined || dependency.projectId !== work.projectId) {
        throw new ProjectDomainError(
          "project_work_dependency_invalid",
          "Work依赖不存在或跨Project",
        );
      }
      if (dependencyId === work.projectWorkId) {
        throw new ProjectDomainError("project_work_dependency_cycle", "Work不能依赖自身");
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (work: ProjectWorkShape): void => {
    if (visiting.has(work.projectWorkId)) {
      throw new ProjectDomainError("project_work_dependency_cycle", "Work依赖存在循环");
    }
    if (visited.has(work.projectWorkId)) return;
    visiting.add(work.projectWorkId);
    for (const dependencyId of work.dependsOn) visit(byId.get(dependencyId)!);
    visiting.delete(work.projectWorkId);
    visited.add(work.projectWorkId);
  };
  for (const work of works) visit(work);
}

export class ProjectDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDomainError";
  }
}

import { describe, expect, it } from "vitest";
import { compileContentLabProjectContext } from "./project-content-context-use-cases.js";
import {
  getProjectAgentOpeningPacket,
  getProjectAgentOpeningPacketV2,
} from "./project-agent-coordination-use-cases.js";
import { previewContentLabPlaneRollout } from "./content-lab-plane-rollout-use-cases.js";
import {
  createEmptySnapshot,
  type PrincipalId,
  type ProductSnapshot,
  type ProjectEvidenceId,
  type ProjectParticipantId,
  type ProjectPracticeRevisionId,
  type ProjectWork,
  type ProjectWorkId,
} from "@chat/contracts";
import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { CommandIdReusedError } from "./errors.js";
import type {
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
} from "./product-store-port.js";
import {
  adoptProjectPractice,
  blockProjectWork,
  claimProjectWork,
  createContentProductionProject,
  createProjectWork,
  decideProjectWorkTransition,
  handoffProjectWork,
  recordContentPublication,
  recordProjectEvidence,
  registerProjectAgent,
  requestProjectWorkReview,
  resumeProjectWork,
} from "./project-coordination-use-cases.js";
import { observeProjectResource } from "./project-use-cases/lifecycle.js";
import {
  adoptProjectConfiguration,
  proposeProjectConfiguration,
} from "./project-management-use-cases.js";
import {
  compileProjectAgentContext,
  getProjectHome,
} from "./project-management-query-use-cases.js";

const PRINCIPAL = "usr_contentlab" as PrincipalId;
const INITIAL_NOW = "2026-08-24T10:00:00.000Z";
const LEASE_END = "2026-08-24T11:00:00.000Z";
const LATER_LEASE_END = "2026-08-24T14:00:00.000Z";
const SHA256 = "a".repeat(64) as never;

class InMemoryProductStore implements ProductStorePort {
  #snapshot: ProductSnapshot;
  readonly #now: () => string;

  constructor(snapshot: ProductSnapshot, now: () => string) {
    this.#snapshot = structuredClone(snapshot);
    this.#now = now;
  }

  async read(): Promise<{ readonly snapshot: Readonly<ProductSnapshot> }> {
    return { snapshot: structuredClone(this.#snapshot) };
  }

  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const prior = this.#snapshot.commandReceipts[transaction.commandId];
    if (prior !== undefined) {
      if (
        prior.commandType !== transaction.commandType ||
        prior.requestSha256 !== transaction.requestSha256
      ) {
        throw new CommandIdReusedError(transaction.commandId);
      }
      return {
        storeRevision: this.#snapshot.storeRevision,
        resultRefs: { ...prior.resultRefs },
        replayed: true,
      };
    }

    const draft = structuredClone(this.#snapshot);
    const mutation = transaction.mutate(draft);
    const committedAt = this.#now();
    draft.storeRevision += 1;
    draft.committedAt = committedAt;
    draft.commandReceipts[transaction.commandId] = {
      commandId: transaction.commandId,
      commandType: transaction.commandType,
      requestSha256: transaction.requestSha256 as never,
      resultRefs: { ...mutation.resultRefs },
      committedStoreRevision: draft.storeRevision,
      createdAt: committedAt,
    };
    this.#snapshot = draft;
    return {
      storeRevision: draft.storeRevision,
      resultRefs: { ...mutation.resultRefs },
      replayed: false,
    };
  }

  inspect(): ProductSnapshot {
    return structuredClone(this.#snapshot);
  }
}

interface Fixture {
  readonly deps: ApplicationDeps;
  readonly store: InMemoryProductStore;
  setNow(value: string): void;
}

interface ProjectFixture extends Fixture {
  readonly projectId: string;
  readonly ownerId: ProjectParticipantId;
  readonly resourceId: string;
  readonly agentIds: readonly ProjectParticipantId[];
}

function fixture(): Fixture {
  let now = INITIAL_NOW;
  let sequence = 0;
  const allocate = (prefix: string) => () => `${prefix}_${++sequence}` as never;
  const store = new InMemoryProductStore(createEmptySnapshot(now), () => now);
  const projectIds: NonNullable<ApplicationDeps["projectIds"]> = {
    project: allocate("prj"),
    methodSnapshot: allocate("pms"),
    stage: allocate("pst"),
    resource: allocate("prs"),
    participant: allocate("ppt"),
    work: allocate("pwk"),
    action: allocate("pac"),
    contribution: allocate("pct"),
    evidence: allocate("pev"),
    decision: allocate("pdc"),
    observation: allocate("pob"),
    candidate: allocate("pca"),
    milestone: allocate("pml"),
    update: allocate("pup"),
    stateTransition: allocate("ptr"),
    workBlock: allocate("pbl"),
    workClaim: allocate("pcl"),
    workHandoff: allocate("phf"),
    practiceRevision: allocate("ppr"),
    workOutcome: allocate("pwo"),
    contextMap: allocate("pcm"),
    providerBinding: allocate("pvb"),
    providerProjection: allocate("pvp"),
  };
  return {
    store,
    setNow(value) {
      now = value;
    },
    deps: {
      store,
      now: () => now,
      ids: new Proxy(
        {},
        {
          get: () => () => {
            throw new Error("内容协调用例不应分配通用产品ID");
          },
        },
      ) as ApplicationDeps["ids"],
      projectIds,
      projectRoots: {
        list: () => [
          {
            rootId: "root_contentlab",
            displayName: "Ziji Content Lab",
            enabledAdapters: ["local-git-workspace.v1", "content-lab-resource.v1"],
          },
        ],
        observe: async () => {
          throw new Error("创建内容项目不应主动扫描受管Root");
        },
      },
    },
  };
}

function command(label: string) {
  return `cmd_${label}` as never;
}

function coordinatedWork(f: Fixture, workId: string): Exclude<ProjectWork, { kind: "generic" }> {
  const work = projectWork(f, workId);
  if (work.kind === "generic") throw new Error("测试Work不是内容Work");
  return work;
}

function projectWork(f: Fixture, workId: string): ProjectWork {
  const work = f.store.inspect().entities.projectWorks[workId];
  if (work === undefined) throw new Error("测试Work不存在");
  return work;
}

function projectRevision(f: ProjectFixture): number {
  const project = f.store.inspect().entities.projects[f.projectId];
  if (project === undefined) throw new Error("测试Project不存在");
  return project.revision;
}

async function bootstrapProject(
  agentNames: readonly string[] = ["Codex"],
): Promise<ProjectFixture> {
  const f = fixture();
  const created = await createContentProductionProject(f.deps, {
    principalId: PRINCIPAL,
    commandId: command("createproject"),
    payload: {
      rootId: "root_contentlab",
      name: "Content Lab",
      summary: "把外语视频转译为可发布的中文内容。",
      goal: "持续发布内容，并用真实案例打磨内容工作流。",
      scopeIn: ["内容交付", "工作流改进"],
      scopeOut: ["自动替用户确认发布成功"],
      successCriteria: ["发布历史可追溯", "方法改进有证据"],
    },
  });
  const projectId = created.project.project.projectId;
  const owner = created.project.participants.find((participant) => participant.kind === "human");
  const resource = created.project.resources[0];
  if (owner === undefined || resource === undefined) throw new Error("内容项目基础对象缺失");

  const agentIds: ProjectParticipantId[] = [];
  for (const [index, name] of agentNames.entries()) {
    const registered = await registerProjectAgent(f.deps, {
      principalId: PRINCIPAL,
      commandId: command(`register${index + 1}`),
      projectId,
      expectedProjectRevision: f.store.inspect().entities.projects[projectId]!.revision,
      payload: { displayName: name, role: "协作执行Agent" },
    });
    const agent = registered.project.participants.find(
      (participant) => participant.kind === "agent" && participant.displayName === name,
    );
    if (agent === undefined) throw new Error("Agent注册失败");
    agentIds.push(agent.projectParticipantId);
  }

  return {
    ...f,
    projectId,
    ownerId: owner.projectParticipantId,
    resourceId: resource.projectResourceId,
    agentIds,
  };
}

async function bootstrapSoftwareProject(
  agentNames: readonly string[] = ["Codex", "Pi"],
): Promise<ProjectFixture> {
  const f = fixture();
  const projectId = "prj_software1";
  const methodId = "pms_software1";
  const stageId = "pst_software1";
  const ownerId = "ppt_softwareowner" as ProjectParticipantId;
  const resourceId = "prs_softwarerepo";
  const policies = compileProjectMethodSnapshotPolicies("software-delivery.v1");
  const rationale = "用户明确选择软件交付Profile。";
  await f.store.transact({
    commandId: command("seedsoftware"),
    commandType: "SeedSoftwareProjectTest",
    requestSha256: SHA256,
    mutate: (draft) => {
      draft.entities.projectMethodSnapshots[methodId] = {
        schemaVersion: "project-method-snapshot.v3",
        projectMethodSnapshotId: methodId as never,
        projectId: projectId as never,
        profileId: "software-delivery.v1",
        rationale,
        policies,
        source: "user_tailored",
        sha256: computeProjectMethodSnapshotSha256({
          profileId: "software-delivery.v1",
          rationale,
          policies,
          source: "user_tailored",
        }) as never,
        revision: 1,
        createdAt: INITIAL_NOW,
        updatedAt: INITIAL_NOW,
      };
      draft.entities.projectStages[stageId] = {
        schemaVersion: "project-stage.v2",
        projectStageId: stageId as never,
        projectId: projectId as never,
        methodSnapshotId: methodId as never,
        key: "delivery",
        name: "软件交付",
        goal: "完成可验证的软件变更。",
        successCriteria: ["Commit与测试证据可追溯"],
        status: "active",
        sequence: 1,
        startedAt: INITIAL_NOW,
        completionEvidenceIds: [],
        revision: 1,
        createdAt: INITIAL_NOW,
        updatedAt: INITIAL_NOW,
      };
      draft.entities.projects[projectId] = {
        schemaVersion: "project.v2",
        projectId: projectId as never,
        ownerPrincipalId: PRINCIPAL,
        name: "真实软件项目",
        summary: "通过Issue、代码、测试和Review持续交付。",
        goal: "让多个Agent安全协作完成软件Work。",
        scopeIn: ["缺陷修复", "功能开发", "测试"],
        scopeOut: ["未经用户决定自动完成"],
        successCriteria: ["跨Agent恢复", "完成证据可追溯"],
        status: "active",
        methodSnapshotId: methodId as never,
        currentStageId: stageId as never,
        revision: 1,
        createdAt: INITIAL_NOW,
        updatedAt: INITIAL_NOW,
      };
      draft.entities.projectParticipants[ownerId] = {
        schemaVersion: "project-participant.v1",
        projectParticipantId: ownerId,
        projectId: projectId as never,
        kind: "human",
        principalId: PRINCIPAL,
        displayName: "项目所有者",
        role: "owner",
        status: "active",
        revision: 1,
        createdAt: INITIAL_NOW,
        updatedAt: INITIAL_NOW,
      };
      draft.entities.projectResources[resourceId] = {
        schemaVersion: "project-resource.v1",
        projectResourceId: resourceId as never,
        projectId: projectId as never,
        rootId: "root_contentlab",
        displayName: "软件Git仓库",
        kind: "workspace",
        enabledAdapters: ["local-git-workspace.v1", "project-document-manifest.v1"],
        status: "active",
        revision: 1,
        createdAt: INITIAL_NOW,
        updatedAt: INITIAL_NOW,
      };
      return { resultRefs: { projectId } };
    },
  });

  const agentIds: ProjectParticipantId[] = [];
  for (const [index, name] of agentNames.entries()) {
    const registered = await registerProjectAgent(f.deps, {
      principalId: PRINCIPAL,
      commandId: command(`registersoftware${index + 1}`),
      projectId,
      expectedProjectRevision: f.store.inspect().entities.projects[projectId]!.revision,
      payload: { displayName: name, role: "软件协作Agent" },
    });
    const agent = registered.project.participants.find(
      (participant) => participant.kind === "agent" && participant.displayName === name,
    );
    if (agent === undefined) throw new Error("软件Agent注册失败");
    agentIds.push(agent.projectParticipantId);
  }
  const candidate = await proposeProjectConfiguration(f.deps, {
    principalId: PRINCIPAL,
    commandId: command("softwareconfiguration"),
    projectId: projectId as never,
    expectedProjectRevision: f.store.inspect().entities.projects[projectId]!.revision,
    payload: {
      profileKey: "software-delivery",
      objective: "通过Issue、代码、测试和Review持续交付软件。",
      scopeIn: ["缺陷修复", "功能开发", "测试"],
      scopeOut: ["未经用户决定自动完成"],
      successCriteria: ["跨Agent恢复", "完成证据可追溯"],
      timezone: "Asia/Shanghai",
      schedulePolicy: {
        mode: "delivery",
        plannedActualComparison: true,
        recurrenceEnabled: false,
        cadences: [],
      },
      participantIds: [ownerId, ...agentIds],
      resourceBindings: [
        {
          projectResourceId: resourceId as never,
          role: "source",
          required: true,
          capabilities: ["discover", "read", "version", "diff", "search"],
        },
      ],
      presentationBindings: [
        {
          capability: "work",
          providerKind: "external-work-tracker.v1",
          bindingRef: "software:work",
          mode: "primary",
        },
        {
          capability: "code",
          providerKind: "code-workbench.v1",
          bindingRef: "software:source",
          mode: "primary",
        },
        {
          capability: "document",
          providerKind: "embedded-document-view.v1",
          bindingRef: "software:docs",
          mode: "primary",
        },
      ],
      terminology: { work: "Issue / Work" },
      requiredReads: ["AGENTS.md", "CONTRIBUTING.md"],
    },
  });
  await adoptProjectConfiguration(f.deps, {
    principalId: PRINCIPAL,
    commandId: command("adoptsoftwareconfiguration"),
    projectId: projectId as never,
    expectedProjectRevision: f.store.inspect().entities.projects[projectId]!.revision,
    expectedCandidateRevision: candidate.configuration.revision,
    payload: {
      candidateConfigurationRevisionId: candidate.configuration.projectConfigurationRevisionId,
      candidateRevision: candidate.configuration.revision,
      candidateSha256: candidate.configuration.sha256,
      decidedByParticipantId: ownerId,
      rationale: "用户审核后采用软件交付管理配置。",
    },
  });
  return { ...f, projectId, ownerId, resourceId, agentIds };
}

async function createContentWork(
  f: ProjectFixture,
  key: string,
  commandLabel = `create${key.replaceAll(".", "")}`,
): Promise<ProjectWorkId> {
  const result = await createProjectWork(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(commandLabel),
    projectId: f.projectId,
    expectedProjectRevision: projectRevision(f),
    payload: {
      kind: "content_delivery",
      workKey: key,
      title: `交付 ${key}`,
      objective: "生成可审核、可发布且版本明确的中文内容。",
      acceptanceCriteria: ["内容版本已保存", "质量检查已完成"],
      ownerParticipantId: f.ownerId,
      dependsOn: [],
      practiceRevisionIds: [],
      resourceRefs: ["content-lab:cases"],
      targetPlatforms: ["xiaohongshu"],
      sourceRef: `youtube:${key}`,
    },
  });
  const work = result.project.works.find((item) => item.workKey === key);
  if (work === undefined) throw new Error("Content Work创建失败");
  return work.projectWorkId;
}

async function createPracticeWork(
  f: ProjectFixture,
  key: string,
  practiceRevisionIds: readonly ProjectPracticeRevisionId[] = [],
): Promise<ProjectWorkId> {
  const result = await createProjectWork(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`create${key.replaceAll(".", "")}`),
    projectId: f.projectId,
    expectedProjectRevision: projectRevision(f),
    payload: {
      kind: "workflow_improvement",
      workKey: key,
      title: `改进 ${key}`,
      objective: "用真实内容案例验证并固化可复用工作方法。",
      acceptanceCriteria: ["至少一个真实案例", "方法版本可追溯"],
      ownerParticipantId: f.ownerId,
      dependsOn: [],
      practiceRevisionIds: [...practiceRevisionIds],
      resourceRefs: ["content-lab:workflows"],
      practiceKey: "translation-hook",
      hypothesis: "先提炼中文受众冲突点可以提高开头的信息密度。",
    },
  });
  const work = result.project.works.find((item) => item.workKey === key);
  if (work === undefined) throw new Error("Practice Work创建失败");
  return work.projectWorkId;
}

async function selectWork(f: ProjectFixture, workId: ProjectWorkId, label: string): Promise<void> {
  await decideProjectWorkTransition(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`select${label}`),
    projectId: f.projectId,
    workId,
    expectedWorkRevision: coordinatedWork(f, workId).revision,
    payload: {
      decidedByParticipantId: f.ownerId,
      targetState: "selected",
      rationale: "用户确认该工作进入当前执行范围。",
      evidenceIds: [],
    },
  });
}

async function claimWork(
  f: ProjectFixture,
  workId: ProjectWorkId,
  participantId: ProjectParticipantId,
  label: string,
  leaseExpiresAt = LEASE_END,
): Promise<void> {
  await claimProjectWork(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`claim${label}`),
    projectId: f.projectId,
    workId,
    expectedWorkRevision: coordinatedWork(f, workId).revision,
    payload: { participantId, leaseExpiresAt },
  });
}

async function recordEvidence(
  f: ProjectFixture,
  input: {
    readonly workId: ProjectWorkId;
    readonly role:
      | "artifact"
      | "commit"
      | "content_revision"
      | "practice_revision"
      | "publication_receipt"
      | "qc_report"
      | "test";
    readonly verification: "reported" | "observed" | "verified";
    readonly label: string;
    readonly sourceKind?: "project_resource" | "user_decision";
  },
): Promise<ProjectEvidenceId> {
  const before = new Set(Object.keys(f.store.inspect().entities.projectEvidence));
  const sourceKind = input.sourceKind ?? "project_resource";
  await recordProjectEvidence(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`evidence${input.label.replaceAll(/[^A-Za-z0-9]/gu, "")}`),
    projectId: f.projectId,
    payload: {
      workId: input.workId,
      workRevision: projectWork(f, input.workId).revision,
      ...(sourceKind === "project_resource" ? { resourceId: f.resourceId as never } : {}),
      role: input.role,
      verification: input.verification,
      sourceKind,
      label: input.label,
      revisionRef: `revision:${input.label}`,
      sha256: SHA256,
      observedAt: f.deps.now(),
    },
  });
  const evidenceId = Object.keys(f.store.inspect().entities.projectEvidence).find(
    (id) => !before.has(id),
  );
  if (evidenceId === undefined) throw new Error("Evidence未提交");
  return evidenceId as ProjectEvidenceId;
}

async function prepareContentForReview(f: ProjectFixture, key: string) {
  const workId = await createContentWork(f, key);
  await selectWork(f, workId, key);
  await claimWork(f, workId, f.agentIds[0]!, key);
  const contentRevisionEvidenceId = await recordEvidence(f, {
    workId,
    role: "content_revision",
    verification: "observed",
    label: `${key}content`,
  });
  const qcEvidenceId = await recordEvidence(f, {
    workId,
    role: "qc_report",
    verification: "observed",
    label: `${key}qc`,
  });
  await requestProjectWorkReview(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`review${key}`),
    projectId: f.projectId,
    workId,
    expectedWorkRevision: coordinatedWork(f, workId).revision,
    payload: {
      participantId: f.agentIds[0]!,
      evidenceIds: [contentRevisionEvidenceId, qcEvidenceId],
      summary: "内容版本与质检证据已经齐备，请用户审核。",
    },
  });
  return { workId, contentRevisionEvidenceId, qcEvidenceId };
}

async function prepareContentReady(f: ProjectFixture, key: string) {
  const prepared = await prepareContentForReview(f, key);
  await decideProjectWorkTransition(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`ready${key}`),
    projectId: f.projectId,
    workId: prepared.workId,
    expectedWorkRevision: coordinatedWork(f, prepared.workId).revision,
    payload: {
      decidedByParticipantId: f.ownerId,
      targetState: "ready",
      rationale: "用户审核内容版本和质检结果后确认可发布。",
      evidenceIds: [prepared.contentRevisionEvidenceId, prepared.qcEvidenceId],
    },
  });
  return prepared;
}

async function preparePracticeForReview(f: ProjectFixture, workId: ProjectWorkId, label: string) {
  await selectWork(f, workId, label);
  await claimWork(f, workId, f.agentIds[0]!, label);
  const artifactEvidenceId = await recordEvidence(f, {
    workId,
    role: "practice_revision",
    verification: "observed",
    label: `${label}practice`,
  });
  await requestProjectWorkReview(f.deps, {
    principalId: PRINCIPAL,
    commandId: command(`review${label}`),
    projectId: f.projectId,
    workId,
    expectedWorkRevision: coordinatedWork(f, workId).revision,
    payload: {
      participantId: f.agentIds[0]!,
      evidenceIds: [artifactEvidenceId],
      summary: "方法修订和真实案例证据已经齐备，请用户决定是否采用。",
    },
  });
  return artifactEvidenceId;
}

describe("Content Production Coordination纵向", () => {
  it("1. 创建内容项目、Context Map、用户责任人、Agent与Content Work", async () => {
    const f = await bootstrapProject(["Codex"]);
    const workId = await createContentWork(f, "content.001");
    const snapshot = f.store.inspect();
    const project = snapshot.entities.projects[f.projectId];
    const method = project && snapshot.entities.projectMethodSnapshots[project.methodSnapshotId];

    expect(method?.profileId).toBe("content-production.v1");
    expect(Object.values(snapshot.entities.projectContextMaps)).toHaveLength(1);
    expect(
      snapshot.entities.projectContextMaps[Object.keys(snapshot.entities.projectContextMaps)[0]!],
    ).toMatchObject({ projectId: f.projectId, status: "active" });
    expect(snapshot.entities.projectParticipants[f.ownerId]).toMatchObject({
      kind: "human",
      role: "owner",
    });
    expect(snapshot.entities.projectParticipants[f.agentIds[0]!]).toMatchObject({
      kind: "agent",
      status: "active",
    });
    expect(snapshot.entities.projectWorks[workId]).toMatchObject({
      kind: "content_delivery",
      workKey: "content.001",
      status: "intake",
      ownerParticipantId: f.ownerId,
    });
  });

  it("2. Agent Claim后提交精确Evidence并请求审核，用户决定Ready", async () => {
    const f = await bootstrapProject();
    const prepared = await prepareContentReady(f, "content.002");
    const snapshot = f.store.inspect();
    const work = snapshot.entities.projectWorks[prepared.workId];

    expect(work).toMatchObject({ status: "ready", revision: 5 });
    expect(work?.activeClaimId).toBeUndefined();
    expect(Object.values(snapshot.entities.projectWorkClaims)).toEqual([
      expect.objectContaining({ status: "released", releaseReason: "review_requested" }),
    ]);
    expect(Object.values(snapshot.entities.projectContributions)).toEqual([
      expect.objectContaining({ kind: "review", evidenceStatus: "verified" }),
    ]);
    expect(Object.values(snapshot.entities.projectStateTransitions).map((item) => item.to)).toEqual(
      expect.arrayContaining(["selected", "producing", "needs_review", "ready"]),
    );
  });

  it("3. Ready不等于Published：没有confirmed Publication Outcome时拒绝发布终态", async () => {
    const f = await bootstrapProject();
    const prepared = await prepareContentReady(f, "content.003");

    await expect(
      decideProjectWorkTransition(f.deps, {
        principalId: PRINCIPAL,
        commandId: command("publishwithoutoutcome"),
        projectId: f.projectId,
        workId: prepared.workId,
        expectedWorkRevision: coordinatedWork(f, prepared.workId).revision,
        payload: {
          decidedByParticipantId: f.ownerId,
          targetState: "published",
          rationale: "尝试在没有发布回执时结束Work。",
          evidenceIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: "project_work_publication_required" });
    expect(coordinatedWork(f, prepared.workId).status).toBe("ready");
    expect(Object.values(f.store.inspect().entities.projectWorkOutcomes)).toHaveLength(0);
  });

  it("4. verified发布回执形成独立Outcome后，用户才能决定Published", async () => {
    const f = await bootstrapProject();
    const prepared = await prepareContentReady(f, "content.004");
    const publicationEvidenceId = await recordEvidence(f, {
      workId: prepared.workId,
      role: "publication_receipt",
      verification: "verified",
      sourceKind: "user_decision",
      label: "content004receipt",
    });
    await recordContentPublication(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("recordpublication"),
      projectId: f.projectId,
      workId: prepared.workId,
      expectedWorkRevision: coordinatedWork(f, prepared.workId).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        platform: "xiaohongshu",
        contentRevisionEvidenceId: prepared.contentRevisionEvidenceId,
        publicationEvidenceId,
        externalContentId: "xhs-note-004",
        url: "https://www.xiaohongshu.com/explore/xhs-note-004",
        publishedAt: f.deps.now(),
        verification: "user_confirmed",
        rationale: "用户核对平台页面后确认发布成功。",
      },
    });
    await decideProjectWorkTransition(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("confirmpublished"),
      projectId: f.projectId,
      workId: prepared.workId,
      expectedWorkRevision: coordinatedWork(f, prepared.workId).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        targetState: "published",
        rationale: "发布结果已由独立Outcome确认。",
        evidenceIds: [publicationEvidenceId],
      },
    });

    const snapshot = f.store.inspect();
    expect(snapshot.entities.projectWorks[prepared.workId]).toMatchObject({
      status: "published",
      revision: 6,
    });
    expect(Object.values(snapshot.entities.projectWorkOutcomes)).toEqual([
      expect.objectContaining({
        workId: prepared.workId,
        status: "confirmed",
        platform: "xiaohongshu",
        publicationEvidenceId,
      }),
    ]);
  });

  it("5. Blocked Work通过Handoff释放旧Claim，新Agent认领并凭恢复证据回到原State", async () => {
    const f = await bootstrapProject(["Codex", "Pi"]);
    const workId = await createContentWork(f, "content.005");
    await selectWork(f, workId, "blocked");
    await claimWork(f, workId, f.agentIds[0]!, "blocked");
    await blockProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("blockwork"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: coordinatedWork(f, workId).revision,
      payload: {
        participantId: f.agentIds[0]!,
        reason: "来源字幕缺少中间章节。",
        stoppedAt: "已完成前两章翻译，第三章无法继续。",
        recoveryConditions: ["补齐第三章字幕", "核对时间轴连续性"],
      },
    });
    await handoffProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("handoffblocked"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: coordinatedWork(f, workId).revision,
      payload: {
        fromParticipantId: f.agentIds[0]!,
        toParticipantId: f.agentIds[1]!,
        completed: ["前两章翻译"],
        remaining: ["补齐第三章字幕", "完成后续翻译"],
        risks: ["自动字幕可能错位"],
        nextStep: "先重新抓取第三章字幕。",
        requiredReads: ["content-lab:cases/content.005"],
        evidenceIds: [],
      },
    });
    await claimWork(f, workId, f.agentIds[1]!, "afterhandoff");
    const recoveryEvidenceId = await recordEvidence(f, {
      workId,
      role: "artifact",
      verification: "observed",
      label: "content005recovery",
    });
    await resumeProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("resumeblocked"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: coordinatedWork(f, workId).revision,
      payload: {
        participantId: f.agentIds[1]!,
        recoveryEvidenceIds: [recoveryEvidenceId],
      },
    });

    const snapshot = f.store.inspect();
    const work = snapshot.entities.projectWorks[workId];
    expect(work).toMatchObject({ status: "producing" });
    expect(work?.activeBlockId).toBeUndefined();
    expect(snapshot.entities.projectWorkClaims[work?.activeClaimId ?? ""]).toMatchObject({
      participantId: f.agentIds[1],
      status: "active",
    });
    expect(Object.values(snapshot.entities.projectWorkHandoffs)).toEqual([
      expect.objectContaining({
        fromParticipantId: f.agentIds[0],
        toParticipantId: f.agentIds[1],
      }),
    ]);
    expect(Object.values(snapshot.entities.projectWorkBlocks)).toEqual([
      expect.objectContaining({ status: "resolved", resolutionKind: "recovered" }),
    ]);

    const handedOff = await getProjectAgentOpeningPacketV2(f.deps, {
      principalId: PRINCIPAL,
      query: {
        workspaceRootId: "root_contentlab" as never,
        participantId: f.agentIds[1],
        includeResourceContext: false,
      },
    });
    expect(handedOff.packet.currentWork).toMatchObject({
      projectWorkId: workId,
      status: "producing",
      activeClaim: { participantId: f.agentIds[1], ownedByRequester: true },
      latestHandoff: {
        fromParticipantId: f.agentIds[0],
        toParticipantId: f.agentIds[1],
        completed: ["前两章翻译"],
        remaining: ["补齐第三章字幕", "完成后续翻译"],
        nextStep: "先重新抓取第三章字幕。",
        evidenceIds: [],
      },
    });
    expect(handedOff.packet.permissions.allowedActions).toEqual(
      expect.arrayContaining(["progress", "block", "request_review", "record_evidence", "handoff"]),
    );
    expect(handedOff.packet).not.toHaveProperty("plane");
    expect(handedOff.packet).not.toHaveProperty("pendingOperations");
    expect(handedOff.packet).not.toHaveProperty("pendingInboundChanges");
  });

  it("6. 活动Claim冲突失败关闭；租约过期后允许另一Agent接管", async () => {
    const f = await bootstrapProject(["Codex", "Pi"]);
    const workId = await createContentWork(f, "content.006");
    await selectWork(f, workId, "lease");
    await claimWork(f, workId, f.agentIds[0]!, "leaseowner");

    await expect(
      claimProjectWork(f.deps, {
        principalId: PRINCIPAL,
        commandId: command("claimconflict"),
        projectId: f.projectId,
        workId,
        expectedWorkRevision: coordinatedWork(f, workId).revision,
        payload: { participantId: f.agentIds[1]!, leaseExpiresAt: LATER_LEASE_END },
      }),
    ).rejects.toMatchObject({ code: "project_work_claim_conflict" });
    expect(Object.values(f.store.inspect().entities.projectWorkClaims)).toHaveLength(1);

    f.setNow("2026-08-24T12:00:00.000Z");
    await claimWork(f, workId, f.agentIds[1]!, "expiredtakeover", LATER_LEASE_END);
    const snapshot = f.store.inspect();
    expect(Object.values(snapshot.entities.projectWorkClaims)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participantId: f.agentIds[0], status: "expired" }),
        expect.objectContaining({ participantId: f.agentIds[1], status: "active" }),
      ]),
    );
    expect(snapshot.entities.projectWorks[workId]?.activeClaimId).toBe(
      Object.values(snapshot.entities.projectWorkClaims).find(
        (claim) => claim.participantId === f.agentIds[1],
      )?.projectWorkClaimId,
    );
  });

  it("7. 跨Work Evidence不能用于请求审核，失败不释放当前Claim", async () => {
    const f = await bootstrapProject();
    const foreignWorkId = await createContentWork(f, "content.007a");
    const foreignEvidenceId = await recordEvidence(f, {
      workId: foreignWorkId,
      role: "content_revision",
      verification: "observed",
      label: "foreigncontent",
    });
    const workId = await createContentWork(f, "content.007b");
    await selectWork(f, workId, "evidenceboundary");
    await claimWork(f, workId, f.agentIds[0]!, "evidenceboundary");

    await expect(
      requestProjectWorkReview(f.deps, {
        principalId: PRINCIPAL,
        commandId: command("crossworkreview"),
        projectId: f.projectId,
        workId,
        expectedWorkRevision: coordinatedWork(f, workId).revision,
        payload: {
          participantId: f.agentIds[0]!,
          evidenceIds: [foreignEvidenceId],
          summary: "错误地引用另一Work的内容版本。",
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const work = coordinatedWork(f, workId);
    expect(work.status).toBe("producing");
    expect(f.store.inspect().entities.projectWorkClaims[work.activeClaimId ?? ""]).toMatchObject({
      status: "active",
    });
  });

  it("8. Practice采用形成版本并可显式替代；命令重放幂等且过期revision被拒绝", async () => {
    const f = await bootstrapProject();
    const firstWorkId = await createPracticeWork(f, "practice.001");
    const firstEvidenceId = await preparePracticeForReview(f, firstWorkId, "practiceone");
    await adoptProjectPractice(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("adoptpracticeone"),
      projectId: f.projectId,
      workId: firstWorkId,
      expectedWorkRevision: coordinatedWork(f, firstWorkId).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        title: "中文冲突点开头方法",
        artifactEvidenceId: firstEvidenceId,
        applicableWorkKinds: ["content_delivery", "workflow_improvement"],
        rationale: "真实案例证明该方法能够稳定生成可审核开头。",
      },
    });
    const firstPractice = Object.values(f.store.inspect().entities.projectPracticeRevisions)[0];
    if (firstPractice === undefined) throw new Error("首个Practice Revision未生成");

    const createSecondInput = {
      principalId: PRINCIPAL,
      commandId: command("createpractice002"),
      projectId: f.projectId,
      expectedProjectRevision: projectRevision(f),
      payload: {
        kind: "workflow_improvement" as const,
        workKey: "practice.002",
        title: "改进 practice.002",
        objective: "用第二批真实案例修订同一方法。",
        acceptanceCriteria: ["新版本证据可追溯"],
        ownerParticipantId: f.ownerId,
        dependsOn: [],
        practiceRevisionIds: [firstPractice.projectPracticeRevisionId],
        resourceRefs: ["content-lab:workflows"],
        practiceKey: "translation-hook",
        hypothesis: "加入平台字数约束后方法更稳定。",
      },
    };
    const createdSecond = await createProjectWork(f.deps, createSecondInput);
    const revisionAfterCreate = f.store.inspect().storeRevision;
    const workCountAfterCreate = Object.keys(f.store.inspect().entities.projectWorks).length;
    const replayedSecond = await createProjectWork(f.deps, createSecondInput);
    expect(replayedSecond).toEqual(createdSecond);
    expect(f.store.inspect().storeRevision).toBe(revisionAfterCreate);
    expect(Object.keys(f.store.inspect().entities.projectWorks)).toHaveLength(workCountAfterCreate);

    await expect(
      createProjectWork(f.deps, {
        ...createSecondInput,
        commandId: command("staleprojectrevision"),
        payload: { ...createSecondInput.payload, workKey: "practice.stale" },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const secondWork = createdSecond.project.works.find((work) => work.workKey === "practice.002");
    if (secondWork === undefined) throw new Error("第二个Practice Work未生成");
    const secondEvidenceId = await preparePracticeForReview(
      f,
      secondWork.projectWorkId,
      "practicetwo",
    );
    await adoptProjectPractice(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("adoptpracticetwo"),
      projectId: f.projectId,
      workId: secondWork.projectWorkId,
      expectedWorkRevision: coordinatedWork(f, secondWork.projectWorkId).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        title: "中文冲突点开头方法（平台约束版）",
        artifactEvidenceId: secondEvidenceId,
        applicableWorkKinds: ["content_delivery", "workflow_improvement"],
        supersedesRevisionId: firstPractice.projectPracticeRevisionId,
        rationale: "第二批案例证明新版保留质量并更适配平台约束。",
      },
    });

    const practices = Object.values(f.store.inspect().entities.projectPracticeRevisions).sort(
      (left, right) => left.version - right.version,
    );
    expect(practices).toHaveLength(2);
    expect(practices[0]).toMatchObject({ version: 1, status: "superseded" });
    expect(practices[1]).toMatchObject({
      version: 2,
      status: "adopted",
      supersedesRevisionId: firstPractice.projectPracticeRevisionId,
    });
    expect(practices[0]?.supersededByRevisionId).toBe(practices[1]?.projectPracticeRevisionId);
    expect(coordinatedWork(f, secondWork.projectWorkId)).toMatchObject({
      status: "adopted",
      practiceRevisionIds: [
        firstPractice.projectPracticeRevisionId,
        practices[1]?.projectPracticeRevisionId,
      ],
    });
  });

  it("9. Content Lab Observation只产生审核候选，Context Compiler返回最小开工上下文", async () => {
    const f = await bootstrapProject();
    const workId = await createContentWork(f, "content.observed");
    let generation = 1;
    let receivedSelection: unknown;
    const file = (relativePath: string, sha256 = SHA256) => ({
      relativePath,
      sha256,
      sizeBytes: 32,
    });
    const contentLab = () => ({
      schemaVersion: "content-lab-observation.v1" as const,
      catalog: {
        governance: [file("AGENTS.md")],
        workflows: [file("workflows/video_translation_workflow.md")],
        templates: [file("templates/xiaohongshu_youtube_shorts_translation_dub_template.md")],
        seriesRegistries: [],
        cases: [file("cases/2026-08-02_xhs_case.md")],
      },
      jobs: [
        {
          jobKey: "xiaohongshu/jobs/2026-08-24_observed",
          platform: "xiaohongshu" as const,
          date: "2026-08-24",
          source: file("xiaohongshu/jobs/2026-08-24_observed/source.md"),
          publish: file(
            "xiaohongshu/jobs/2026-08-24_observed/publish.md",
            (generation === 1 ? "b" : "c").repeat(64) as never,
          ),
          sourceUrls: ["https://youtube.com/watch?v=observed"],
          workflowRevisionRefs: ["workflows/video_translation_workflow.md"],
          readiness: "needs_review" as const,
          blockerSignals: [],
          recommendedArtifacts: [],
          fingerprintSha256: (generation === 1 ? "d" : "e").repeat(64) as never,
        },
      ],
      scanStats: {
        trackedFileCount: 10,
        relevantTextFileCount: 5,
        candidateJobCount: 1,
        selectedArtifactCount: 0,
        ignoredTrackedMediaCount: 0,
        hashedArtifactBytes: 0,
        artifactInspectionPolicy: "recommended_paths_only" as const,
        truncated: false,
      },
    });
    const deps: ApplicationDeps = {
      ...f.deps,
      projectRoots: {
        list: () => f.deps.projectRoots!.list(),
        observe: async () => ({
          descriptor: f.deps.projectRoots!.list()[0]!,
          data: {
            git: {
              headSha: "1".repeat(40),
              branch: "main",
              dirty: false,
              trackedFileCount: 10,
              recentCommitCount: 1,
            },
            documents: [],
            scripts: [],
            contentLab: contentLab(),
          },
        }),
        compileContentLabContext: async (input) => {
          receivedSelection = input.selection;
          return {
            schemaVersion: "content-lab-context-bundle.v1",
            observationSha256: input.observationSha256 as never,
            selectedJobKeys: ["xiaohongshu/jobs/2026-08-24_observed"],
            items: [
              {
                role: "governance",
                relativePath: "AGENTS.md",
                sha256: SHA256,
                sizeBytes: 32,
                reason: "Content Lab根治理规则",
                content: "发布必须经过用户审核。",
              },
            ],
            history: [
              {
                jobKey: "xiaohongshu/jobs/2026-08-24_observed",
                platform: "xiaohongshu",
                date: "2026-08-24",
                readiness: "needs_review",
                sourceUrls: ["https://youtube.com/watch?v=observed"],
                workflowRevisionRefs: ["workflows/video_translation_workflow.md"],
              },
            ],
            totalCharacters: 12,
            excludedItemCount: 0,
            truncated: false,
          };
        },
      },
    };

    await observeProjectResource(deps, {
      principalId: PRINCIPAL,
      commandId: command("observebaseline"),
      projectId: f.projectId,
      resourceId: f.resourceId,
    });
    let observations = Object.values(f.store.inspect().entities.projectObservations);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.changeCandidate).toMatchObject({
      classification: "baseline",
      prohibitsAutomaticCompletion: true,
    });

    generation = 2;
    f.setNow("2026-08-24T10:01:00.000Z");
    await observeProjectResource(deps, {
      principalId: PRINCIPAL,
      commandId: command("observechanged"),
      projectId: f.projectId,
      resourceId: f.resourceId,
    });
    observations = Object.values(f.store.inspect().entities.projectObservations).sort(
      (left, right) => left.observedAt.localeCompare(right.observedAt),
    );
    expect(observations[1]?.changeCandidate).toMatchObject({
      classification: "review_required",
      changeKinds: ["work_evidence"],
      prohibitsAutomaticCompletion: true,
    });
    expect(observations[1]?.changeCandidate?.changedPaths).toEqual(
      expect.arrayContaining([
        "xiaohongshu/jobs/2026-08-24_observed",
        "xiaohongshu/jobs/2026-08-24_observed/publish.md",
      ]),
    );
    expect(coordinatedWork(f, workId).status).toBe("intake");
    expect(Object.values(f.store.inspect().entities.projectWorkOutcomes)).toHaveLength(0);
    expect(Object.values(f.store.inspect().entities.projectPracticeRevisions)).toHaveLength(0);

    const context = await compileContentLabProjectContext(deps, {
      principalId: PRINCIPAL,
      projectId: f.projectId,
      resourceId: f.resourceId,
      workId,
    });
    expect(receivedSelection).toMatchObject({
      workKind: "content_delivery",
      targetPlatforms: ["xiaohongshu"],
      resourceRefs: ["content-lab:cases"],
    });
    expect(context).toMatchObject({
      schemaVersion: "content-lab-project-context.v1",
      resource: { changeCandidateClassification: "review_required" },
      providerSnapshot: null,
      resourceContext: { selectedJobKeys: ["xiaohongshu/jobs/2026-08-24_observed"] },
    });
    expect(context.evidence).toHaveLength(2);
    expect(context.work.status).toBe("intake");
  });

  it("10. Resolver从Product Session恢复唯一Root，多个Work时拒绝猜测并支持显式Work Key", async () => {
    const f = await bootstrapProject(["Codex"]);
    const firstWorkId = await createContentWork(f, "content.resolver.one", "createresolverone");
    await createContentWork(f, "content.resolver.two", "createresolvertwo");
    await f.store.transact({
      commandId: command("seedresolverbinding"),
      commandType: "SeedProjectResolverBinding",
      requestSha256: "f".repeat(64),
      mutate: (draft) => {
        draft.entities.sessions["psn_resolver1"] = {
          schemaVersion: "product-session.v1",
          sessionId: "psn_resolver1" as never,
          ownerPrincipalId: PRINCIPAL,
          status: "active",
          lastMessageSequence: 0,
          revision: 1,
          createdAt: INITIAL_NOW,
          updatedAt: INITIAL_NOW,
        };
        draft.entities.projectWorkspaceBindings["pwb_resolver1"] = {
          schemaVersion: "project-bootstrap.v1",
          projectWorkspaceBindingId: "pwb_resolver1" as never,
          ownerPrincipalId: PRINCIPAL,
          productSessionId: "psn_resolver1" as never,
          projectBootstrapOperationId: "pbo_resolver1" as never,
          providerKind: "plane_ce",
          planeWorkspaceSlug: "ai",
          planeProjectId: "c77bd889-4a8f-4651-9f39-da79af010781",
          planeProjectIdentifier: "CONTENTLAB",
          workspaceRootId: "root_contentlab" as never,
          directoryName: "ziji-content-lab",
          status: "active",
          revision: 1,
          createdAt: INITIAL_NOW,
          updatedAt: INITIAL_NOW,
        };
        return { resultRefs: { productSessionId: "psn_resolver1" } };
      },
    });

    const ambiguous = await getProjectAgentOpeningPacket(f.deps, {
      principalId: PRINCIPAL,
      query: {
        productSessionId: "psn_resolver1" as never,
        participantId: f.agentIds[0],
        includeResourceContext: false,
        refreshPlane: false,
      },
    });
    expect(ambiguous.packet.resolution).toMatchObject({
      projectId: f.projectId,
      sources: ["product_session"],
      workspaceRootId: "root_contentlab",
    });
    expect(ambiguous.packet.currentWork).toBeNull();
    expect(ambiguous.packet.requiresWorkSelection).toBe(true);
    expect(ambiguous.packet.permissions.allowedActions).toContain("select_work");

    const selected = await getProjectAgentOpeningPacket(f.deps, {
      principalId: PRINCIPAL,
      query: {
        productSessionId: "psn_resolver1" as never,
        workKey: "content.resolver.one",
        participantId: f.agentIds[0],
        includeResourceContext: false,
        refreshPlane: false,
      },
    });
    expect(selected.packet.currentWork).toMatchObject({
      projectWorkId: firstWorkId,
      workKey: "content.resolver.one",
      status: "intake",
    });
    expect(selected.packet.completionGate).toMatchObject({
      terminalState: "published",
      humanDecisionRequired: true,
      publicationOutcomeRequired: true,
      automaticTerminalTransitionAllowed: false,
    });
  });

  it("11. P8 Dry Run合并真实Resource语义和完整Plane只读快照，5个样本都保持Candidate", async () => {
    const f = await bootstrapProject(["Codex"]);
    const file = (relativePath: string) => ({
      relativePath,
      sha256: SHA256,
      sizeBytes: 64,
    });
    const casePath = "cases/2026-07-05_xhs_burned_in_english_caption_replacement_case.md";
    const job = (
      jobKey: string,
      platform: "xiaohongshu" | "bilibili",
      readiness: "review_ready" | "needs_review" | "blocked",
      seriesKey?: string,
    ) => ({
      jobKey,
      platform,
      date: jobKey.match(/\d{4}-\d{2}-\d{2}/u)?.[0] ?? "2026-08-24",
      ...(seriesKey === undefined ? {} : { seriesKey }),
      source: file(`${jobKey}/source.md`),
      publish: file(`${jobKey}/publish.md`),
      qc: file(`${jobKey}/analysis/qc.md`),
      sourceUrls: [],
      workflowRevisionRefs: [],
      readiness,
      blockerSignals: readiness === "blocked" ? ["测试环境阻塞"] : [],
      recommendedArtifacts: [],
      fingerprintSha256: SHA256,
    });
    const contentLab = {
      schemaVersion: "content-lab-observation.v1" as const,
      catalog: {
        governance: [file("AGENTS.md")],
        workflows: [],
        templates: [],
        seriesRegistries: [],
        cases: [file(casePath)],
      },
      jobs: [
        job(
          "xiaohongshu/jobs/2026-08-02_elapse_dahlia_seed_sprouting_timelapse",
          "xiaohongshu",
          "review_ready",
        ),
        job(
          "xiaohongshu/series/monstrofarm/jobs/2026-07-29_monstrofarm_leaves_told_wrong",
          "xiaohongshu",
          "needs_review",
          "monstrofarm",
        ),
        job(
          "bilibili/series/crash_course_botany/jobs/2026-07-03_ep02_what_are_plants_made_of",
          "bilibili",
          "review_ready",
          "crash_course_botany",
        ),
        job(
          "xiaohongshu/jobs/2026-07-24_elapse_watermelon_sprouting_timelapse",
          "xiaohongshu",
          "blocked",
        ),
      ],
      scanStats: {
        trackedFileCount: 30,
        relevantTextFileCount: 20,
        candidateJobCount: 4,
        selectedArtifactCount: 0,
        ignoredTrackedMediaCount: 0,
        hashedArtifactBytes: 0,
        artifactInspectionPolicy: "recommended_paths_only" as const,
        truncated: false,
      },
    };
    const deps: ApplicationDeps = {
      ...f.deps,
      projectRoots: {
        list: () => f.deps.projectRoots!.list(),
        observe: async () => ({
          descriptor: f.deps.projectRoots!.list()[0]!,
          data: {
            git: {
              headSha: "1".repeat(40),
              branch: "main",
              dirty: false,
              trackedFileCount: 30,
              recentCommitCount: 1,
            },
            documents: [],
            scripts: [],
            contentLab,
          },
        }),
        compileContentLabContext: async (input) => {
          const sourceRef = input.selection.sourceRef ?? input.selection.resourceRefs[0]!;
          const practice = input.selection.workKind === "workflow_improvement";
          const title = practice ? "烧录英文字幕替换质量门" : sourceRef.split("/").at(-1)!;
          return {
            schemaVersion: "content-lab-context-bundle.v1",
            observationSha256: input.observationSha256 as never,
            selectedJobKeys: practice ? [] : [sourceRef],
            items: [
              {
                role: practice ? ("case" as const) : ("current_job" as const),
                relativePath: practice ? sourceRef : `${sourceRef}/publish.md`,
                sha256: SHA256,
                sizeBytes: 64,
                reason: "Dry Run只读取代表性标题",
                content: `# ${title}`,
              },
            ],
            history: [],
            totalCharacters: title.length + 2,
            excludedItemCount: 0,
            truncated: false,
          };
        },
      },
      planeProjectRolloutInspection: {
        describe: () => ({
          providerKind: "plane_ce",
          providerVersion: "1.4.1",
          allowedWorkspaceSlugs: ["later"],
        }),
        inspectProject: async () => ({
          project: {
            id: "99999999-9999-4999-8999-999999999999",
            name: "Ziji Content Lab",
            identifier: "CONTENTLAB",
            description: "人类已有描述",
            network: 0,
            moduleView: true,
            cycleView: false,
            issueViewsView: false,
            pageView: true,
            intakeView: false,
          },
          states: [
            {
              id: "state-intake",
              name: "Intake",
              group: "backlog",
              color: "#60646C",
              sequence: 10,
            },
            {
              id: "state-human",
              name: "Human Custom",
              group: "started",
              color: "#000000",
              sequence: 15,
            },
          ],
          surfaceAvailability: {
            views: "available",
            pages: "available",
            intakes: "available",
          },
          modules: [
            { id: "module-xhs", name: "小红书内容交付", description: "" },
            { id: "module-human", name: "现有人类Module", description: "" },
          ],
          labels: [{ id: "label-kind", name: "kind:content", color: "#2563EB" }],
          views: [
            {
              id: "view-human",
              name: "01 当前执行",
              description: "人类自定义视图",
              filtersJson: "{}",
              displayFiltersJson: "{}",
              archived: false,
            },
          ],
          pages: [
            {
              id: "page-human",
              name: "Content Lab 项目导航",
              access: 1,
              locked: false,
              archived: false,
            },
          ],
          intakes: [],
          workItems: [],
        }),
      },
    };
    const storeRevision = f.store.inspect().storeRevision;
    const first = await previewContentLabPlaneRollout(deps, {
      principalId: PRINCIPAL,
      query: {
        projectId: f.projectId as never,
        workspaceRootId: "root_contentlab" as never,
        planeWorkspaceSlug: "later",
        planeProjectIdentifier: "CONTENTLAB",
      },
    });
    expect(first.dryRun).toMatchObject({
      mode: "dry_run",
      currentCounts: { states: 2, modules: 2, labels: 1, views: 1, pages: 1, intakes: 0 },
      summary: { destructive: 0 },
      executionAuthorized: false,
      planeWrites: 0,
    });
    expect(first.dryRun.samples).toHaveLength(5);
    expect(first.dryRun.samples.every((sample) => sample.authority === "candidate_only")).toBe(
      true,
    );
    expect(first.dryRun.samples.map((sample) => sample.desiredState)).not.toContain("Published");
    expect(first.dryRun.operations.every((operation) => operation.destructive === false)).toBe(
      true,
    );
    expect(first.dryRun.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetKind: "intake", action: "manual_review" }),
        expect.objectContaining({
          targetKind: "view",
          displayName: "01 当前执行",
          action: "manual_review",
        }),
        expect.objectContaining({
          targetKind: "page",
          displayName: "Content Lab 项目导航",
          action: "manual_review",
        }),
      ]),
    );
    expect(first.dryRun.warnings).toEqual(
      expect.arrayContaining([
        "保留未知State，不删除：Human Custom",
        "保留现有Module，不删除：现有人类Module",
      ]),
    );
    f.setNow("2026-08-24T10:30:00.000Z");
    const repeated = await previewContentLabPlaneRollout(deps, {
      principalId: PRINCIPAL,
      query: {
        projectId: f.projectId as never,
        workspaceRootId: "root_contentlab" as never,
        planeWorkspaceSlug: "later",
        planeProjectIdentifier: "CONTENTLAB",
      },
    });
    expect(repeated.dryRun.dryRunSha256).toBe(first.dryRun.dryRunSha256);
    expect(f.store.inspect().storeRevision).toBe(storeRevision);
  });
});

describe("Generic Software Work Coordination纵向", () => {
  it("通用Work跨Agent Claim、Block、Handoff、Review，并以Commit+Test和用户Decision完成", async () => {
    const f = await bootstrapSoftwareProject();
    const created = await createProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("createsoftwarework"),
      projectId: f.projectId,
      expectedProjectRevision: projectRevision(f),
      payload: {
        kind: "generic",
        workKey: "github:issue:5110",
        title: "修复并发关闭竞态",
        objective: "复现竞态、提交最小修复并防止回归。",
        acceptanceCriteria: ["竞态测试稳定通过", "变更经过用户审核"],
        ownerParticipantId: f.ownerId,
        dependsOn: [],
        practiceRevisionIds: [],
        resourceRefs: ["github:pipecat-ai/pipecat#5110"],
      },
    });
    const workId = created.project.works.find(
      (work) => work.workKey === "github:issue:5110",
    )?.projectWorkId;
    if (workId === undefined) throw new Error("通用Work未创建");
    expect(projectWork(f, workId)).toMatchObject({ kind: "generic", status: "draft" });
    await decideProjectWorkTransition(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("approvesoftwarework"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        targetState: "approved",
        rationale: "用户确认该Issue进入当前交付范围。",
        evidenceIds: [],
      },
    });
    expect(projectWork(f, workId).status).toBe("approved");

    await claimProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("claimsoftwarecodex"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: { participantId: f.agentIds[0]!, leaseExpiresAt: LEASE_END },
    });
    expect(projectWork(f, workId).status).toBe("in_progress");
    await blockProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("blocksoftware"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: {
        participantId: f.agentIds[0]!,
        reason: "缺少可稳定复现Provider竞态的时序夹具。",
        stoppedAt: "已定位close_context与后台任务交错窗口。",
        recoveryConditions: ["补齐确定性时序夹具"],
      },
    });
    expect(projectWork(f, workId)).toMatchObject({
      status: "blocked",
      activeBlockId: expect.any(String),
    });
    await handoffProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("handoffsoftware"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: {
        fromParticipantId: f.agentIds[0]!,
        toParticipantId: f.agentIds[1]!,
        completed: ["定位竞态窗口"],
        remaining: ["实现时序夹具", "提交修复和回归测试"],
        risks: ["Provider回调时序可能变化"],
        nextStep: "先写失败测试锁定交错顺序。",
        requiredReads: ["github:pipecat-ai/pipecat#5110"],
        evidenceIds: [],
      },
    });
    await claimProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("claimsoftwarepi"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: { participantId: f.agentIds[1]!, leaseExpiresAt: LATER_LEASE_END },
    });
    const recoveryEvidenceId = await recordEvidence(f, {
      workId,
      role: "artifact",
      verification: "observed",
      label: "timingfixture",
    });
    await resumeProjectWork(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("resumesoftware"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: {
        participantId: f.agentIds[1]!,
        recoveryEvidenceIds: [recoveryEvidenceId],
      },
    });
    const opening = await getProjectAgentOpeningPacket(f.deps, {
      principalId: PRINCIPAL,
      query: {
        projectId: f.projectId as never,
        participantId: f.agentIds[1],
        includeResourceContext: false,
        refreshPlane: false,
      },
    });
    expect(opening.packet.currentWork).toMatchObject({
      projectWorkId: workId,
      kind: "generic",
      status: "in_progress",
      activeClaim: { participantId: f.agentIds[1], ownedByRequester: true },
      latestHandoff: {
        completed: ["定位竞态窗口"],
        remaining: ["实现时序夹具", "提交修复和回归测试"],
      },
    });
    expect(opening.packet.permissions.allowedActions).toEqual(
      expect.arrayContaining(["progress", "block", "request_review", "record_evidence", "handoff"]),
    );
    expect(opening.packet.completionGate).toMatchObject({
      terminalState: "done",
      requiredEvidenceRoles: ["commit", "test"],
      humanDecisionRequired: true,
    });
    expect(opening.packet.management).toMatchObject({
      status: "ready",
      context: { requiredReads: ["AGENTS.md", "CONTRIBUTING.md"] },
    });

    const commitEvidenceId = await recordEvidence(f, {
      workId,
      role: "commit",
      verification: "observed",
      label: "pipecatcommit",
    });
    const testEvidenceId = await recordEvidence(f, {
      workId,
      role: "test",
      verification: "observed",
      label: "pipecattest",
    });
    await requestProjectWorkReview(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("reviewsoftware"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: {
        participantId: f.agentIds[1]!,
        evidenceIds: [commitEvidenceId, testEvidenceId],
        summary: "修复与回归测试已提交，请用户审核。",
      },
    });
    await expect(
      decideProjectWorkTransition(f.deps, {
        principalId: PRINCIPAL,
        commandId: command("donesoftwaremissingevidence"),
        projectId: f.projectId,
        workId,
        expectedWorkRevision: projectWork(f, workId).revision,
        payload: {
          decidedByParticipantId: f.ownerId,
          targetState: "done",
          rationale: "尝试仅凭Commit结束Work。",
          evidenceIds: [commitEvidenceId],
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await decideProjectWorkTransition(f.deps, {
      principalId: PRINCIPAL,
      commandId: command("donesoftware"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: projectWork(f, workId).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        targetState: "done",
        rationale: "用户核对Commit与测试证据后确认完成。",
        evidenceIds: [commitEvidenceId, testEvidenceId],
      },
    });
    const snapshot = f.store.inspect();
    expect(snapshot.entities.projectWorks[workId]).toMatchObject({
      status: "done",
      resolutionDecisionId: expect.any(String),
    });
    expect(Object.values(snapshot.entities.projectWorkBlocks)).toEqual([
      expect.objectContaining({ status: "resolved", resolutionKind: "recovered" }),
    ]);
    expect(Object.values(snapshot.entities.projectWorkHandoffs)).toHaveLength(1);
    expect(Object.values(snapshot.entities.projectContributions)).toEqual([
      expect.objectContaining({ kind: "review", evidenceIds: [commitEvidenceId, testEvidenceId] }),
    ]);
    const home = await getProjectHome(f.deps, {
      principalId: PRINCIPAL,
      projectId: f.projectId,
    });
    expect(home.projectHome.objectCounts).toMatchObject({
      work: 1,
      claim: 2,
      block: 1,
      handoff: 1,
      review: 1,
    });
    expect(home.projectHome.recentEvents.map((event) => event.title)).toEqual(
      expect.arrayContaining([
        "work.created",
        "work.claimed",
        "work.blocked",
        "work.handed-off",
        "work.resumed",
        "work.review-requested",
        "work.transition-decided",
      ]),
    );
    const handoffContext = await compileProjectAgentContext(f.deps, {
      principalId: PRINCIPAL,
      projectId: f.projectId,
      purpose: "handoff",
    });
    expect(handoffContext.context.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["work", "claim", "block", "handoff", "evidence", "decision"]),
    );
    const reviewContext = await compileProjectAgentContext(f.deps, {
      principalId: PRINCIPAL,
      projectId: f.projectId,
      purpose: "review",
    });
    expect(reviewContext.context.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["work", "review", "evidence"]),
    );
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockProjectWork,
  adoptExistingPlaneProject,
  claimProjectWork,
  createContentProductionProject,
  createProjectWork,
  decideProjectWorkTransition,
  handoffProjectWork,
  listPlaneWorkItemComments,
  listPlaneProjectInboundChanges,
  recordContentPublication,
  recordProjectEvidence,
  registerProjectAgent,
  requestProjectWorkReview,
  executePlaneProjectOperation,
  getProjectAgentOpeningPacket,
  preparePlaneProjectOperation,
  reconcilePlaneProjectOperation,
  syncPlaneProject,
  resumeProjectWork,
  resolvePlaneProjectInboundChange,
  type ApplicationDeps,
  type IdFactory,
  type ProductReadRequest,
  type ProductReadResult,
  type ProductStorePort,
  type ProductTransaction,
  type ProductTransactionResult,
  type ProjectIdFactory,
  type PlaneProjectCoordinationPort,
  type PlaneProviderCommentIntent,
  type PlaneProviderCommentResult,
  type PlaneProviderEnsureWorkItemIntent,
  type PlaneProviderProjectSnapshot,
  type PlaneProviderTransitionIntent,
  type PlaneProviderWorkItem,
  type PlaneProviderWorkItemResult,
} from "@chat/application";
import {
  type CommandId,
  type PrincipalId,
  type ProductSnapshot,
  type ProjectEvidenceId,
  type ProjectParticipantId,
  type ProjectWork,
  type ProjectWorkId,
} from "@chat/contracts";
import { JsonProductStore, assertSnapshotIntegrity } from "@chat/product-store-json";

const OWNER = "usr_contentvertical" as PrincipalId;
const SHA256 = "a".repeat(64) as never;
const STARTED_AT = Date.parse("2026-08-24T10:00:00.000Z");

/**
 * 纵向测试仍把真实JsonProductStore作为物理事实源；这个窄装饰器只在每次成功事务后
 * 重新读取已提交快照并显式执行完整Integrity入口，防止测试只验证最终结果而漏掉中间坏状态。
 */
class IntegrityCheckedStore implements ProductStorePort {
  integrityChecks = 0;

  constructor(readonly jsonStore: JsonProductStore) {}

  read(query: ProductReadRequest): Promise<ProductReadResult> {
    return this.jsonStore.read(query);
  }

  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const result = await this.jsonStore.transact(transaction);
    const { snapshot } = await this.jsonStore.read({ kind: "committedSnapshot" });
    assertSnapshotIntegrity(structuredClone(snapshot) as ProductSnapshot);
    this.integrityChecks += 1;
    return result;
  }
}

interface VerticalFixture {
  readonly deps: ApplicationDeps;
  readonly store: IntegrityCheckedStore;
  readonly filePath: string;
  readonly command: (label: string) => CommandId;
  readonly now: () => string;
}

interface ProjectFixture extends VerticalFixture {
  readonly projectId: string;
  readonly ownerId: ProjectParticipantId;
  readonly resourceId: string;
  readonly agentIds: readonly ProjectParticipantId[];
}

function idFactories(): { readonly ids: IdFactory; readonly projectIds: ProjectIdFactory } {
  const counters = new Map<string, number>();
  const next = (prefix: string): string => {
    const value = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, value);
    return `${prefix}_${value.toString().padStart(6, "0")}`;
  };
  return {
    ids: {
      session: () => next("psn") as never,
      message: () => next("msg") as never,
      run: () => next("run") as never,
      attempt: () => next("att") as never,
      plan: () => next("pln") as never,
      planRevision: () => next("plr") as never,
      revisionInput: () => next("rin") as never,
      approval: () => next("apr") as never,
      decision: () => next("dec") as never,
      executionContract: () => next("exc") as never,
      executionCandidate: () => next("xcd") as never,
      validationResult: () => next("val") as never,
      artifact: () => next("art") as never,
      outbox: () => next("obx") as never,
    },
    projectIds: {
      project: () => next("prj") as never,
      methodSnapshot: () => next("pms") as never,
      stage: () => next("pst") as never,
      resource: () => next("prs") as never,
      participant: () => next("ppt") as never,
      work: () => next("pwk") as never,
      action: () => next("pac") as never,
      contribution: () => next("pct") as never,
      evidence: () => next("pev") as never,
      decision: () => next("pdc") as never,
      observation: () => next("pob") as never,
      candidate: () => next("pca") as never,
      milestone: () => next("pml") as never,
      update: () => next("pup") as never,
      stateTransition: () => next("ptr") as never,
      workBlock: () => next("pbl") as never,
      workClaim: () => next("pcl") as never,
      workHandoff: () => next("phf") as never,
      practiceRevision: () => next("ppr") as never,
      workOutcome: () => next("pwo") as never,
      contextMap: () => next("pcm") as never,
      providerBinding: () => next("pvb") as never,
      providerProjection: () => next("pvp") as never,
    },
  };
}

async function fixture(): Promise<VerticalFixture> {
  const directory = await mkdtemp(join(tmpdir(), "chat-content-production-vertical-"));
  const filePath = join(directory, "product.json");
  let clock = 0;
  let commandSequence = 0;
  const now = () => new Date(STARTED_AT + clock++ * 1_000).toISOString();
  const jsonStore = await JsonProductStore.open({ filePath, now });
  const store = new IntegrityCheckedStore(jsonStore);
  const factories = idFactories();
  return {
    filePath,
    store,
    now,
    command: (label) =>
      `cmd_${label}${(++commandSequence).toString().padStart(3, "0")}` as CommandId,
    deps: {
      store,
      now,
      ids: factories.ids,
      projectIds: factories.projectIds,
      projectRoots: {
        list: () => [
          {
            rootId: "root_contentlab",
            displayName: "Content Lab Test Root",
            enabledAdapters: ["project-document-manifest.v1", "package-script-catalog.v1"],
          },
        ],
        observe: async () => {
          throw new Error("内容生产创建与协调纵向不应扫描真实Content Lab目录");
        },
      },
    },
  };
}

async function snapshot(f: VerticalFixture): Promise<ProductSnapshot> {
  const result = await f.store.read({ kind: "committedSnapshot" });
  return structuredClone(result.snapshot) as ProductSnapshot;
}

async function coordinatedWork(
  f: VerticalFixture,
  workId: ProjectWorkId,
): Promise<Exclude<ProjectWork, { kind: "generic" }>> {
  const work = (await snapshot(f)).entities.projectWorks[workId];
  if (work === undefined || work.kind === "generic") throw new Error("测试Content Work不存在");
  return work;
}

async function projectRevision(f: ProjectFixture): Promise<number> {
  const project = (await snapshot(f)).entities.projects[f.projectId];
  if (project === undefined) throw new Error("测试Project不存在");
  return project.revision;
}

async function bootstrap(agentNames: readonly string[]): Promise<ProjectFixture> {
  const f = await fixture();
  const created = await createContentProductionProject(f.deps, {
    principalId: OWNER,
    commandId: f.command("createproject"),
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
  const firstSnapshot = await snapshot(f);
  const owner = Object.values(firstSnapshot.entities.projectParticipants).find(
    (participant) => participant.projectId === projectId && participant.kind === "human",
  );
  const resource = Object.values(firstSnapshot.entities.projectResources).find(
    (item) => item.projectId === projectId,
  );
  if (owner === undefined || resource === undefined) throw new Error("内容项目基础对象缺失");

  const agentIds: ProjectParticipantId[] = [];
  for (const name of agentNames) {
    await registerProjectAgent(f.deps, {
      principalId: OWNER,
      commandId: f.command("registeragent"),
      projectId,
      expectedProjectRevision: (await snapshot(f)).entities.projects[projectId]!.revision,
      payload: { displayName: name, role: "协作执行Agent" },
    });
    const participant = Object.values((await snapshot(f)).entities.projectParticipants).find(
      (item) => item.projectId === projectId && item.kind === "agent" && item.displayName === name,
    );
    if (participant === undefined) throw new Error("Agent Participant注册失败");
    agentIds.push(participant.projectParticipantId);
  }

  return {
    ...f,
    projectId,
    ownerId: owner.projectParticipantId,
    resourceId: resource.projectResourceId,
    agentIds,
  };
}

async function createContentWork(f: ProjectFixture, workKey: string): Promise<ProjectWorkId> {
  await createProjectWork(f.deps, {
    principalId: OWNER,
    commandId: f.command("creatework"),
    projectId: f.projectId,
    expectedProjectRevision: await projectRevision(f),
    payload: {
      kind: "content_delivery",
      workKey,
      title: `交付 ${workKey}`,
      objective: "生成可审核、可发布且版本明确的中文内容。",
      acceptanceCriteria: ["内容版本已保存", "质量检查已完成"],
      ownerParticipantId: f.ownerId,
      dependsOn: [],
      practiceRevisionIds: [],
      resourceRefs: ["content-lab:cases"],
      targetPlatforms: ["xiaohongshu"],
      sourceRef: `youtube:${workKey}`,
    },
  });
  const work = Object.values((await snapshot(f)).entities.projectWorks).find(
    (item) => item.projectId === f.projectId && item.workKey === workKey,
  );
  if (work === undefined) throw new Error("Content Work创建失败");
  return work.projectWorkId;
}

async function selectAndClaim(
  f: ProjectFixture,
  workId: ProjectWorkId,
  participantId: ProjectParticipantId,
): Promise<void> {
  await decideProjectWorkTransition(f.deps, {
    principalId: OWNER,
    commandId: f.command("selectwork"),
    projectId: f.projectId,
    workId,
    expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
    payload: {
      decidedByParticipantId: f.ownerId,
      targetState: "selected",
      rationale: "用户确认该工作进入当前执行范围。",
      evidenceIds: [],
    },
  });
  await claimProjectWork(f.deps, {
    principalId: OWNER,
    commandId: f.command("claimwork"),
    projectId: f.projectId,
    workId,
    expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
    payload: {
      participantId,
      leaseExpiresAt: "2026-08-24T18:00:00.000Z",
    },
  });
}

async function recordEvidence(
  f: ProjectFixture,
  input: {
    readonly workId: ProjectWorkId;
    readonly role: "content_revision" | "qc_report" | "publication_receipt" | "artifact";
    readonly verification: "observed" | "verified";
    readonly sourceKind: "project_resource" | "user_decision";
    readonly label: string;
  },
): Promise<ProjectEvidenceId> {
  const before = new Set(Object.keys((await snapshot(f)).entities.projectEvidence));
  await recordProjectEvidence(f.deps, {
    principalId: OWNER,
    commandId: f.command("recordevidence"),
    projectId: f.projectId,
    payload: {
      workId: input.workId,
      workRevision: (await coordinatedWork(f, input.workId)).revision,
      ...(input.sourceKind === "project_resource" ? { resourceId: f.resourceId as never } : {}),
      role: input.role,
      verification: input.verification,
      sourceKind: input.sourceKind,
      label: input.label,
      revisionRef: `revision:${input.label}`,
      sha256: SHA256,
      observedAt: f.now(),
    },
  });
  const evidenceId = Object.keys((await snapshot(f)).entities.projectEvidence).find(
    (id) => !before.has(id),
  );
  if (evidenceId === undefined) throw new Error("Evidence未提交");
  return evidenceId as ProjectEvidenceId;
}

async function assertDurableIntegrity(f: VerticalFixture): Promise<ProductSnapshot> {
  const committed = await snapshot(f);
  expect(f.store.integrityChecks).toBe(committed.storeRevision);
  expect(() => assertSnapshotIntegrity(committed)).not.toThrow();

  const reopened = await JsonProductStore.open({ filePath: f.filePath, now: f.now });
  const persisted = structuredClone(
    (await reopened.read({ kind: "committedSnapshot" })).snapshot,
  ) as ProductSnapshot;
  expect(persisted).toEqual(committed);
  expect(() => assertSnapshotIntegrity(persisted)).not.toThrow();
  return persisted;
}

describe("Content Production Project + JsonProductStore真实纵向", () => {
  it("A. Content Work从创建、精确Evidence、用户Ready到独立Publication Outcome与Published", async () => {
    const f = await bootstrap(["Codex"]);
    const workId = await createContentWork(f, "content.vertical.001");
    await selectAndClaim(f, workId, f.agentIds[0]!);
    const contentRevisionEvidenceId = await recordEvidence(f, {
      workId,
      role: "content_revision",
      verification: "observed",
      sourceKind: "project_resource",
      label: "content-vertical-001-r3",
    });
    const qcEvidenceId = await recordEvidence(f, {
      workId,
      role: "qc_report",
      verification: "observed",
      sourceKind: "project_resource",
      label: "content-vertical-001-qc",
    });
    await requestProjectWorkReview(f.deps, {
      principalId: OWNER,
      commandId: f.command("requestreview"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        participantId: f.agentIds[0]!,
        evidenceIds: [contentRevisionEvidenceId, qcEvidenceId],
        summary: "内容版本与质量检查均已观察，请用户审核。",
      },
    });
    await decideProjectWorkTransition(f.deps, {
      principalId: OWNER,
      commandId: f.command("decideready"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        targetState: "ready",
        rationale: "用户核对内容版本和质检证据后确认可发布。",
        evidenceIds: [contentRevisionEvidenceId, qcEvidenceId],
      },
    });
    const publicationEvidenceId = await recordEvidence(f, {
      workId,
      role: "publication_receipt",
      verification: "verified",
      sourceKind: "user_decision",
      label: "content-vertical-001-publication",
    });
    await recordContentPublication(f.deps, {
      principalId: OWNER,
      commandId: f.command("recordpublication"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        platform: "xiaohongshu",
        contentRevisionEvidenceId,
        publicationEvidenceId,
        externalContentId: "xhs-vertical-001",
        url: "https://www.xiaohongshu.com/explore/xhs-vertical-001",
        publishedAt: f.now(),
        verification: "user_confirmed",
        rationale: "用户核对平台页面和内容版本后确认发布成功。",
      },
    });
    await decideProjectWorkTransition(f.deps, {
      principalId: OWNER,
      commandId: f.command("decidepublished"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        targetState: "published",
        rationale: "所有目标平台均已有独立confirmed Publication Outcome。",
        evidenceIds: [publicationEvidenceId],
      },
    });

    const persisted = await assertDurableIntegrity(f);
    expect(persisted.entities.projectWorks[workId]).toMatchObject({
      kind: "content_delivery",
      status: "published",
      resolutionDecisionId: expect.any(String),
    });
    expect(Object.values(persisted.entities.projectWorkOutcomes)).toEqual([
      expect.objectContaining({
        workId,
        status: "confirmed",
        platform: "xiaohongshu",
        contentRevisionEvidenceId,
        publicationEvidenceId,
      }),
    ]);
    expect(persisted.entities.projectEvidence[publicationEvidenceId]).toMatchObject({
      role: "publication_receipt",
      verification: "verified",
      sourceKind: "user_decision",
    });
  });

  it("B. Blocked Work经完整Handoff释放旧Claim，由新Agent认领并凭恢复Evidence回到Producing", async () => {
    const f = await bootstrap(["Codex", "Pi"]);
    const workId = await createContentWork(f, "content.vertical.002");
    await selectAndClaim(f, workId, f.agentIds[0]!);
    await blockProjectWork(f.deps, {
      principalId: OWNER,
      commandId: f.command("blockwork"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        participantId: f.agentIds[0]!,
        reason: "来源字幕缺少中间章节。",
        stoppedAt: "已完成前两章翻译，第三章无法继续。",
        recoveryConditions: ["补齐第三章字幕", "核对时间轴连续性"],
      },
    });
    await handoffProjectWork(f.deps, {
      principalId: OWNER,
      commandId: f.command("handoffwork"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        fromParticipantId: f.agentIds[0]!,
        toParticipantId: f.agentIds[1]!,
        completed: ["前两章翻译"],
        remaining: ["补齐第三章字幕", "完成后续翻译"],
        risks: ["自动字幕可能错位"],
        nextStep: "先重新抓取第三章字幕。",
        requiredReads: ["content-lab:cases/content.vertical.002"],
        evidenceIds: [],
      },
    });
    await claimProjectWork(f.deps, {
      principalId: OWNER,
      commandId: f.command("claimnewagent"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        participantId: f.agentIds[1]!,
        leaseExpiresAt: "2026-08-24T18:00:00.000Z",
      },
    });
    const recoveryEvidenceId = await recordEvidence(f, {
      workId,
      role: "artifact",
      verification: "observed",
      sourceKind: "project_resource",
      label: "content-vertical-002-recovery",
    });
    await resumeProjectWork(f.deps, {
      principalId: OWNER,
      commandId: f.command("resumework"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        participantId: f.agentIds[1]!,
        recoveryEvidenceIds: [recoveryEvidenceId],
      },
    });

    const persisted = await assertDurableIntegrity(f);
    const work = persisted.entities.projectWorks[workId];
    expect(work).toMatchObject({ kind: "content_delivery", status: "producing" });
    expect(work?.activeBlockId).toBeUndefined();
    expect(persisted.entities.projectWorkClaims[work?.activeClaimId ?? ""]).toMatchObject({
      participantId: f.agentIds[1],
      status: "active",
    });
    expect(Object.values(persisted.entities.projectWorkClaims)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: f.agentIds[0],
          status: "released",
          releaseReason: "handoff",
        }),
        expect.objectContaining({ participantId: f.agentIds[1], status: "active" }),
      ]),
    );
    expect(Object.values(persisted.entities.projectWorkHandoffs)).toEqual([
      expect.objectContaining({
        fromParticipantId: f.agentIds[0],
        toParticipantId: f.agentIds[1],
        remaining: ["补齐第三章字幕", "完成后续翻译"],
      }),
    ]);
    expect(Object.values(persisted.entities.projectWorkBlocks)).toEqual([
      expect.objectContaining({
        status: "resolved",
        resolutionKind: "recovered",
        resolvedEvidenceIds: [recoveryEvidenceId],
      }),
    ]);
  });
});

const PLANE_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const PLANE_MODULE_ID = "88888888-8888-4888-8888-888888888888";
const PLANE_WORK_ITEM_ID = "77777777-7777-4777-8777-777777777777";
const HUMAN_PLANE_ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const KIND_CONTENT_LABEL_ID = "10101010-1010-4010-8010-101010101010";
const PLATFORM_XHS_LABEL_ID = "20202020-2020-4020-8020-202020202020";
const EXECUTOR_CODEX_LABEL_ID = "30303030-3030-4030-8030-303030303030";

const PLANE_STATES = [
  ["11111111-1111-4111-8111-111111111111", "Intake", "backlog"],
  ["22222222-2222-4222-8222-222222222222", "Selected", "unstarted"],
  ["33333333-3333-4333-8333-333333333333", "Producing", "started"],
  ["44444444-4444-4444-8444-444444444444", "Needs Review", "started"],
  ["55555555-5555-4555-8555-555555555555", "Ready", "started"],
  ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Blocked", "started"],
  ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Published", "completed"],
  ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Dropped", "cancelled"],
] as const;

class FakePlaneCoordination implements PlaneProjectCoordinationPort {
  readonly comments = new Map<
    string,
    {
      id: string;
      workItemId: string;
      excerpt: string;
      origin: "later_agent" | "human_or_other";
      actorExternalId?: string;
      externalId?: string;
      createdAt: string;
    }
  >();
  workItem: PlaneProviderWorkItem | undefined;
  sequence = 0;

  describe() {
    return {
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1",
      allowedWorkspaceSlugs: ["later"],
      externalSource: "later-agent" as const,
    };
  }

  async findProjectByIdentifier() {
    return { id: PLANE_PROJECT_ID, name: "Ziji Content Lab", identifier: "CONTENTLAB" };
  }

  async readProjectSnapshot(): Promise<PlaneProviderProjectSnapshot> {
    return {
      project: { id: PLANE_PROJECT_ID, name: "Ziji Content Lab", identifier: "CONTENTLAB" },
      states: PLANE_STATES.map(([id, name, group]) => ({ id, name, group })),
      modules: [
        {
          id: PLANE_MODULE_ID,
          name: "小红书内容交付",
          status: "in-progress",
          totalWorkItems: this.workItem === undefined ? 0 : 1,
          completedWorkItems: 0,
          cancelledWorkItems: 0,
          startedWorkItems: this.workItem?.stateGroup === "started" ? 1 : 0,
          unstartedWorkItems: this.workItem?.stateGroup === "unstarted" ? 1 : 0,
          backlogWorkItems: this.workItem?.stateGroup === "backlog" ? 1 : 0,
        },
      ],
      labels: [
        { id: KIND_CONTENT_LABEL_ID, name: "kind:content", color: "#111111" },
        { id: PLATFORM_XHS_LABEL_ID, name: "platform:xiaohongshu", color: "#222222" },
        { id: EXECUTOR_CODEX_LABEL_ID, name: "executor:codex", color: "#333333" },
      ],
      workItems: this.workItem === undefined ? [] : [structuredClone(this.workItem)],
    };
  }

  async readWorkItemComments(input: {
    readonly workItemId: string;
    readonly workItemExternalId: string;
    readonly limit: number;
  }) {
    if (
      this.workItem?.id !== input.workItemId ||
      this.workItem.externalId !== input.workItemExternalId
    ) {
      throw new Error("fake work item binding不一致");
    }
    const ordered = [...this.comments.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    return {
      comments: ordered.slice(0, input.limit),
      totalCommentCount: ordered.length,
      truncated: ordered.length > input.limit,
    };
  }

  async ensureWorkItem(
    input: PlaneProviderEnsureWorkItemIntent,
  ): Promise<PlaneProviderWorkItemResult> {
    if (this.workItem !== undefined) {
      return this.workItem.externalId === input.externalId
        ? { status: "completed", workItem: structuredClone(this.workItem) }
        : { status: "needs_attention", errorCode: "external_identity_conflict" };
    }
    const state = PLANE_STATES.find(
      ([, name, group]) => name === input.stateName && group === input.stateGroup,
    );
    if (state === undefined) return { status: "failed", errorCode: "state_not_found" };
    this.workItem = {
      id: PLANE_WORK_ITEM_ID,
      sequenceId: 1,
      name: input.name,
      description: input.description,
      priority: input.priority,
      moduleIds: input.moduleIds,
      labelIds: input.labelIds,
      stateId: state[0],
      stateName: state[1],
      stateGroup: state[2],
      externalSource: "later-agent",
      externalId: input.externalId,
      updatedAt: "2026-08-24T12:00:00.000Z",
    };
    return { status: "completed", workItem: structuredClone(this.workItem) };
  }

  async reconcileEnsureWorkItem(
    input: PlaneProviderEnsureWorkItemIntent,
  ): Promise<PlaneProviderWorkItemResult> {
    return this.workItem?.externalId === input.externalId
      ? { status: "completed", workItem: structuredClone(this.workItem) }
      : { status: "outcome_unknown", errorCode: "ensure_not_observed" };
  }

  async preflightWorkItemStateTransition(
    input: PlaneProviderTransitionIntent,
  ): Promise<PlaneProviderWorkItemResult> {
    if (
      this.workItem?.id !== input.workItemId ||
      this.workItem.externalId !== input.workItemExternalId ||
      this.workItem.stateId !== input.expectedStateId
    ) {
      return { status: "needs_attention", errorCode: "state_preflight_conflict" };
    }
    return { status: "completed", workItem: structuredClone(this.workItem) };
  }

  async transitionWorkItemState(
    input: PlaneProviderTransitionIntent,
  ): Promise<PlaneProviderWorkItemResult> {
    const preflight = await this.preflightWorkItemStateTransition(input);
    if (preflight.status !== "completed") return preflight;
    const state = PLANE_STATES.find(
      ([, name, group]) => name === input.stateName && group === input.stateGroup,
    );
    if (state === undefined || this.workItem === undefined) {
      return { status: "failed", errorCode: "state_not_found" };
    }
    this.workItem = {
      ...this.workItem,
      stateId: state[0],
      stateName: state[1],
      stateGroup: state[2],
      updatedAt: "2026-08-24T12:01:00.000Z",
    };
    return { status: "completed", workItem: structuredClone(this.workItem) };
  }

  async reconcileWorkItemStateTransition(
    input: PlaneProviderTransitionIntent,
  ): Promise<PlaneProviderWorkItemResult> {
    if (
      this.workItem?.id === input.workItemId &&
      this.workItem.externalId === input.workItemExternalId &&
      this.workItem.stateName === input.stateName &&
      this.workItem.stateGroup === input.stateGroup
    ) {
      return { status: "completed", workItem: structuredClone(this.workItem) };
    }
    return { status: "needs_attention", errorCode: "state_effect_not_observed" };
  }

  async appendWorkItemComment(
    input: PlaneProviderCommentIntent,
  ): Promise<PlaneProviderCommentResult> {
    const id = `dddddddd-dddd-4ddd-8ddd-${(++this.sequence).toString().padStart(12, "0")}`;
    this.comments.set(input.commentExternalId, {
      id,
      workItemId: input.workItemId,
      excerpt: input.commentHtml.replace(/<[^>]*>/gu, "").trim(),
      origin: "later_agent",
      externalId: input.commentExternalId,
      createdAt: `2026-08-24T12:${this.sequence.toString().padStart(2, "0")}:00.000Z`,
    });
    return { status: "completed", comment: { id, workItemId: input.workItemId } };
  }

  async reconcileWorkItemComment(
    input: PlaneProviderCommentIntent,
  ): Promise<PlaneProviderCommentResult> {
    const comment = this.comments.get(input.commentExternalId);
    return comment === undefined
      ? { status: "outcome_unknown", errorCode: "comment_not_observed" }
      : { status: "completed", comment: { id: comment.id, workItemId: comment.workItemId } };
  }

  async applyCommentedWorkItemStateTransition(input: {
    readonly transition: PlaneProviderTransitionIntent;
    readonly comment: PlaneProviderCommentIntent;
  }) {
    const preflight = await this.preflightWorkItemStateTransition(input.transition);
    if (preflight.status !== "completed") {
      return { phase: "preflight" as const, outcome: preflight };
    }
    const comment = await this.appendWorkItemComment(input.comment);
    if (comment.status !== "completed") return { phase: "comment" as const, outcome: comment };
    return {
      phase: "transition" as const,
      comment: comment.comment,
      outcome: await this.transitionWorkItemState(input.transition),
    };
  }

  humanMove(stateName: string, updates: { readonly name?: string } = {}): void {
    const state = PLANE_STATES.find(([, name]) => name === stateName);
    if (state === undefined || this.workItem === undefined) throw new Error("fake state不存在");
    this.workItem = {
      ...this.workItem,
      ...updates,
      stateId: state[0],
      stateName: state[1],
      stateGroup: state[2],
      updatedById: HUMAN_PLANE_ACTOR_ID,
      updatedAt: `2026-08-24T12:${(++this.sequence).toString().padStart(2, "0")}:00.000Z`,
    };
  }

  humanEdit(updates: {
    readonly name?: string;
    readonly description?: string;
    readonly priority?: "none" | "urgent" | "high" | "medium" | "low";
  }): void {
    if (this.workItem === undefined) throw new Error("fake work item不存在");
    this.workItem = {
      ...this.workItem,
      ...updates,
      updatedById: HUMAN_PLANE_ACTOR_ID,
      updatedAt: `2026-08-24T12:${(++this.sequence).toString().padStart(2, "0")}:00.000Z`,
    };
  }

  humanComment(excerpt: string): void {
    if (this.workItem === undefined) throw new Error("fake work item不存在");
    const id = `eeeeeeee-eeee-4eee-8eee-${(++this.sequence).toString().padStart(12, "0")}`;
    this.comments.set(`human:${id}`, {
      id,
      workItemId: this.workItem.id,
      excerpt,
      origin: "human_or_other",
      actorExternalId: HUMAN_PLANE_ACTOR_ID,
      createdAt: `2026-08-24T12:${this.sequence.toString().padStart(2, "0")}:00.000Z`,
    });
  }
}

describe("Content Production × Plane P5真实Json纵向", () => {
  it("只投影既有Chat Work，并采用可验证人类非终态State；冲突后停止出站写", async () => {
    const f = await bootstrap(["Codex"]);
    const workKey = "content-xhs-sample";
    const workId = await createContentWork(f, workKey);
    await decideProjectWorkTransition(f.deps, {
      principalId: OWNER,
      commandId: f.command("selectbeforeplane"),
      projectId: f.projectId,
      workId,
      expectedWorkRevision: (await coordinatedWork(f, workId)).revision,
      payload: {
        decidedByParticipantId: f.ownerId,
        targetState: "selected",
        rationale: "用户确认先建立Plane投影。",
        evidenceIds: [],
      },
    });

    const plane = new FakePlaneCoordination();
    let coordinationId = 0;
    const deps: ApplicationDeps = {
      ...f.deps,
      planeProjectCoordination: plane,
      planeProjectCoordinationIds: {
        operation: () => `pco_${(++coordinationId).toString().padStart(6, "0")}` as never,
        inboundChange: () => `pic_${(++coordinationId).toString().padStart(6, "0")}` as never,
      },
    };
    const stateMappings = [
      ["intake", "Intake"],
      ["selected", "Selected"],
      ["producing", "Producing"],
      ["needs_review", "Needs Review"],
      ["ready", "Ready"],
      ["blocked", "Blocked"],
      ["published", "Published"],
      ["dropped", "Dropped"],
    ].map(([chatState, providerStateName]) => {
      const state = PLANE_STATES.find(([, name]) => name === providerStateName)!;
      return {
        workKind: "content_delivery" as const,
        chatState: chatState!,
        providerStateId: state[0],
        providerStateName: state[1],
        providerStateGroup: state[2],
      };
    });
    const adopted = await adoptExistingPlaneProject(deps, {
      principalId: OWNER,
      commandId: f.command("adoptplane"),
      projectId: f.projectId,
      projectKey: "content-lab",
      workspaceRootId: "root_contentlab",
      coordinationAgentParticipantId: f.agentIds[0]!,
      humanActorExternalIds: [HUMAN_PLANE_ACTOR_ID],
      planeWorkspaceSlug: "later",
      planeProjectIdentifier: "CONTENTLAB",
      stateMappings,
      moduleMappings: [
        {
          mappingKey: "platform:xiaohongshu",
          providerModuleId: PLANE_MODULE_ID,
          providerModuleName: "小红书内容交付",
        },
      ],
      labelMappings: [
        {
          mappingKey: "kind:content",
          providerLabelId: KIND_CONTENT_LABEL_ID,
          providerLabelName: "kind:content",
        },
        {
          mappingKey: "platform:xiaohongshu",
          providerLabelId: PLATFORM_XHS_LABEL_ID,
          providerLabelName: "platform:xiaohongshu",
        },
        {
          mappingKey: "executor:codex",
          providerLabelId: EXECUTOR_CODEX_LABEL_ID,
          providerLabelName: "executor:codex",
        },
      ],
    });
    const bindingId = adopted.binding.planeProjectBindingId;
    const prepared = await preparePlaneProjectOperation(deps, {
      principalId: OWNER,
      commandId: f.command("prepareensure"),
      planeProjectBindingId: bindingId,
      expectedBindingRevision: adopted.binding.revision,
      intent: {
        kind: "ensure_work_item",
        externalSource: "later-agent",
        externalId: workKey,
        taskKey: workKey,
        name: "调用方标题不会成为第二事实",
        description: "调用方描述不会覆盖Chat Work。",
        priority: "none",
        stateName: "Selected",
        stateGroup: "unstarted",
      },
    });
    const completed = await executePlaneProjectOperation(deps, {
      principalId: OWNER,
      commandId: f.command("executeensure"),
      planeProjectOperationId: prepared.planeProjectOperationId,
      expectedOperationRevision: prepared.revision,
    });
    expect(completed).toMatchObject({ status: "completed", planeWorkItemId: PLANE_WORK_ITEM_ID });
    const reconcileCommandId = f.command("replayterminalreconcile");
    const reconciled = await reconcilePlaneProjectOperation(deps, {
      principalId: OWNER,
      commandId: reconcileCommandId,
      planeProjectOperationId: completed.planeProjectOperationId,
      expectedPlaneProjectBindingId: bindingId,
      expectedOperationRevision: completed.revision,
    });
    await expect(
      reconcilePlaneProjectOperation(deps, {
        principalId: OWNER,
        commandId: reconcileCommandId,
        planeProjectOperationId: completed.planeProjectOperationId,
        expectedPlaneProjectBindingId: bindingId,
        expectedOperationRevision: completed.revision,
      }),
    ).resolves.toEqual(reconciled);
    const openingPacket = await getProjectAgentOpeningPacket(deps, {
      principalId: OWNER,
      query: {
        workspaceRootId: "root_contentlab" as never,
        participantId: f.agentIds[0],
        includeResourceContext: false,
        refreshPlane: true,
      },
    });
    expect(openingPacket.packet).toMatchObject({
      resolution: {
        projectId: f.projectId,
        sources: ["workspace_root"],
        workspaceRootId: "root_contentlab",
      },
      currentWork: {
        projectWorkId: workId,
        workKey,
        status: "selected",
      },
      plane: {
        status: "ready",
        planeProjectBindingId: bindingId,
        planeProjectIdentifier: "CONTENTLAB",
        currentWorkItem: {
          planeWorkItemId: PLANE_WORK_ITEM_ID,
          stateName: "Selected",
        },
      },
      permissions: {
        allowedActions: ["claim"],
      },
    });
    expect(plane.workItem).toMatchObject({
      name: `交付 ${workKey}`,
      externalId: `chat-work:content-lab:${workKey}`,
      stateName: "Selected",
      moduleIds: [PLANE_MODULE_ID],
      labelIds: [KIND_CONTENT_LABEL_ID, PLATFORM_XHS_LABEL_ID],
    });

    plane.humanComment("请保留原视频中的反例，并在小红书正文里解释。 ");
    const commentSnapshot = await listPlaneWorkItemComments(deps, {
      principalId: OWNER,
      planeProjectBindingId: bindingId,
      planeWorkItemId: PLANE_WORK_ITEM_ID,
      limit: 20,
    });
    expect(commentSnapshot).toMatchObject({
      totalCommentCount: 1,
      truncated: false,
      comments: [
        {
          origin: "human_or_other",
          actorExternalId: HUMAN_PLANE_ACTOR_ID,
          excerpt: "请保留原视频中的反例，并在小红书正文里解释。 ",
        },
      ],
    });

    plane.humanMove("Producing");
    const synchronized = await syncPlaneProject(deps, {
      principalId: OWNER,
      commandId: f.command("syncadoptable"),
      planeProjectBindingId: bindingId,
    });
    expect(synchronized.inboundChanges).toEqual([
      expect.objectContaining({ classification: "adoptable", status: "adopted" }),
    ]);
    expect((await coordinatedWork(f, workId)).status).toBe("producing");

    plane.humanEdit({ name: "人类确认的新标题", priority: "high" });
    const metadata = await syncPlaneProject(deps, {
      principalId: OWNER,
      commandId: f.command("syncmetadata"),
      planeProjectBindingId: bindingId,
    });
    expect(metadata.inboundChanges).toEqual([
      expect.objectContaining({ classification: "adoptable", status: "adopted" }),
    ]);
    expect(await coordinatedWork(f, workId)).toMatchObject({
      title: "人类确认的新标题",
      priority: "high",
    });

    plane.humanEdit({ description: "人在Plane补充了新的内容目标，需要形成候选。" });
    const candidate = await syncPlaneProject(deps, {
      principalId: OWNER,
      commandId: f.command("synccandidate"),
      planeProjectBindingId: bindingId,
    });
    expect(candidate.inboundChanges).toEqual([
      expect.objectContaining({
        changeKind: "description",
        classification: "candidate_required",
        status: "candidate",
      }),
    ]);
    const pending = await listPlaneProjectInboundChanges(deps, {
      principalId: OWNER,
      planeProjectBindingId: bindingId,
      status: "candidate",
      limit: 20,
    });
    expect(pending.inboundChanges).toEqual([
      expect.objectContaining({
        projectInboundChangeId: candidate.inboundChanges[0]!.projectInboundChangeId,
      }),
    ]);
    await resolvePlaneProjectInboundChange(deps, {
      principalId: OWNER,
      commandId: f.command("keepchatdescription"),
      projectInboundChangeId: candidate.inboundChanges[0]!.projectInboundChangeId,
      expectedRevision: candidate.inboundChanges[0]!.revision,
      disposition: "keep_chat",
      rationale: "保留Chat目标；Plane说明作为本次人类协作备注。",
    });

    plane.humanMove("Needs Review", { name: "人在Plane同时修改标题" });
    const conflicted = await syncPlaneProject(deps, {
      principalId: OWNER,
      commandId: f.command("syncconflict"),
      planeProjectBindingId: bindingId,
    });
    expect(conflicted.inboundChanges).toEqual([
      expect.objectContaining({ classification: "forbidden_conflict", status: "needs_attention" }),
    ]);
    await expect(
      preparePlaneProjectOperation(deps, {
        principalId: OWNER,
        commandId: f.command("prepareafterconflict"),
        planeProjectBindingId: bindingId,
        expectedBindingRevision: adopted.binding.revision,
        intent: {
          kind: "progress",
          externalSource: "later-agent",
          externalId: workKey,
          taskKey: workKey,
          planeWorkItemId: PLANE_WORK_ITEM_ID,
          message: "不应覆盖人的并发编辑。",
          branch: "codex/content-lab-plane-p5",
          evidenceIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const persisted = await assertDurableIntegrity(f);
    expect(Object.values(persisted.entities.projectProviderBindings)).toHaveLength(1);
    expect(Object.values(persisted.entities.projectProviderProjections)).toEqual([
      expect.objectContaining({ syncStatus: "needs_attention" }),
    ]);
    expect(Object.values(persisted.entities.projectCoordinationOperations)).toHaveLength(1);
    expect(Object.values(persisted.entities.projectInboundChanges)).toHaveLength(4);
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
  type ApplicationDeps,
  type IdFactory,
  type ProductReadRequest,
  type ProductReadResult,
  type ProductStorePort,
  type ProductTransaction,
  type ProductTransactionResult,
  type ProjectIdFactory,
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

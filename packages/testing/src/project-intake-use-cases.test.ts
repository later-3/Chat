import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  beginProjectIntake,
  beginProjectManagementCandidate,
  assignProjectAction,
  createProjectAction,
  createProductSession,
  decideProjectCandidate,
  decideProjectManagementCandidate,
  getProjectCandidate,
  getCurrentProjectCandidate,
  getProjectTimeline,
  getProjectWorkspace,
  listProjects,
  observeProjectResource,
  prepareProjectCandidateForReview,
  beginProjectAdvancement,
  adoptProjectConfiguration,
  getProjectAgentOpeningPacketV2,
  prepareProjectAdvancementCandidate,
  proposeProjectConfiguration,
  decideProjectAdvancementCandidate,
  recordProjectContribution,
  recordProjectDecision,
  setProjectArchiveStatus,
  transitionProjectAction,
  transitionProjectMilestone,
  transitionProjectLifecycle,
  transitionProjectStage,
  type ApplicationDeps,
  type IdFactory,
  type ProjectIdFactory,
} from "@chat/application";
import { JsonProductStore } from "@chat/product-store-json";
import { createProjectResourceRegistry } from "@chat/project-runtime";

const exec = promisify(execFile);
const NOW = "2026-08-09T08:00:00.000Z";

function ids(): IdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_project${(++value).toString(36)}`;
  return {
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
  };
}

function projectIds(): ProjectIdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_project${(++value).toString(36)}`;
  return {
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
  };
}

async function deps(): Promise<ApplicationDeps> {
  const root = await mkdtemp(join(tmpdir(), "chat-project-intake-root-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "AGENTS.md"), "# Rules\n");
  await writeFile(join(root, "docs", "architecture.md"), "# Architecture\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
  );
  await exec("git", ["init", root]);
  await exec("git", ["-C", root, "config", "user.email", "project@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Project Test"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  const directory = await mkdtemp(join(tmpdir(), "chat-project-intake-store-"));
  let clock = 0;
  const now = () => new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const projectRoots = await createProjectResourceRegistry({
    CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
      {
        rootId: "root_chat",
        displayName: "Chat工作区",
        canonicalPath: root,
        enabledAdapters: [
          "local-git-workspace.v1",
          "project-document-manifest.v1",
          "package-script-catalog.v1",
        ],
      },
    ]),
  });
  return {
    store,
    now,
    ids: ids(),
    projectIds: projectIds(),
    projectRoots,
    projectIntakeUnderstanding: {
      describe: () => ({
        profileVersion: "test.project-model.v1",
        providerName: "test-provider",
        modelId: "test-model",
        promptTemplateVersion: "project-intake-understanding.v1",
        endpointHost: "models.example.test",
      }),
      understand: async () => ({
        understanding: {
          name: "Chat",
          goal: "把Chat建设成可持续推进工作的产品",
          summary: "建立长期项目并明确当前待办",
          scopeHints: ["维护Chat代码和项目文档"],
          successCriteriaHints: ["项目事实可以跨会话恢复"],
          initialWorkHints: ["建立项目基线", "梳理当前待办"],
          openQuestions: [],
        },
        evidence: { durationMs: 5, providerRequestId: "req-test-project" },
      }),
    },
    projectAdvancementUnderstanding: {
      describe: () => ({
        profileVersion: "test.project-model.v1",
        providerName: "test-provider",
        modelId: "test-model",
        promptTemplateVersion: "project-advancement-understanding.v1",
        endpointHost: "models.example.test",
      }),
      understand: async () => ({
        understanding: {
          stage: {
            name: "可用的项目推进",
            goal: "让用户只靠对话推进项目阶段和关键结果",
            successCriteria: ["阶段目标和负责人更新可跨重启恢复"],
          },
          milestones: [
            {
              outcome: "完成PS2.1纵向闭环",
              acceptanceCriteria: ["真实对话到项目账本完整贯通"],
            },
          ],
          update: {
            health: "on_track" as const,
            narrative: "Stage和Milestone方案已准备，等待用户确认。",
            observedChanges: [],
            blockers: [],
            nextFocus: ["完成PS2.1实现和验证"],
          },
        },
        evidence: { durationMs: 7, providerRequestId: "req-test-advancement" },
      }),
    },
  };
}

describe("PS1 Project Intake Application纵向链", () => {
  it("真实资源观察→Candidate修改→确认→原子项目账本→重启Query", async () => {
    const application = await deps();
    const principalId = "usr_projectowner" as never;
    const { session } = await createProductSession(application, {
      principalId,
      commandId: "cmd_projectsession" as never,
      payload: { title: "Project Intake" },
    });
    const begun = await beginProjectIntake(application, {
      principalId,
      commandId: "cmd_projectbegin" as never,
      payload: {
        sessionId: session.sessionId,
        text: "把Chat仓库建成项目，目标是持续开发产品并梳理待办",
        rootId: "root_chat",
      },
    });
    expect(begun.candidate.status).toBe("queued");
    expect(
      (await getCurrentProjectCandidate(application, { principalId, sessionId: session.sessionId }))
        .candidate?.projectCandidateId,
    ).toBe(begun.candidate.projectCandidateId);

    const prepared = await prepareProjectCandidateForReview(application, {
      commandId: "cmd_projectprepare" as never,
      projectCandidateId: begun.candidate.projectCandidateId,
      expectedRevision: 1,
    });
    expect(prepared.candidate.status).toBe("under_review");
    if (
      prepared.candidate.candidateKind !== "intake" ||
      prepared.candidate.status !== "under_review"
    ) {
      throw new Error("candidate not ready");
    }
    expect(prepared.candidate.resource.documentCount).toBe(2);
    expect(prepared.candidate.proposal.method.profileId).toBe("software-delivery.v1");

    const revised = await decideProjectCandidate(application, {
      principalId,
      commandId: "cmd_projectrevise" as never,
      projectCandidateId: prepared.candidate.projectCandidateId,
      expectedRevision: prepared.candidate.revision,
      payload: {
        kind: "revise",
        candidateSha256: prepared.candidate.candidateSha256,
        proposal: { ...prepared.candidate.proposal, name: "Chat产品" },
      },
    });
    expect(revised.candidate.status).toBe("under_review");
    if (
      revised.candidate.candidateKind !== "intake" ||
      revised.candidate.status !== "under_review"
    ) {
      throw new Error("candidate not revised");
    }

    const confirmed = await decideProjectCandidate(application, {
      principalId,
      commandId: "cmd_projectconfirm" as never,
      projectCandidateId: revised.candidate.projectCandidateId,
      expectedRevision: revised.candidate.revision,
      payload: { kind: "confirm", candidateSha256: revised.candidate.candidateSha256 },
    });
    expect(confirmed.candidate.status).toBe("confirmed");
    expect(confirmed.project?.project.name).toBe("Chat产品");
    const projectId = confirmed.project?.project.projectId;
    if (projectId === undefined) throw new Error("project missing");
    expect((await listProjects(application, { principalId })).projects).toHaveLength(1);
    const workspace = await getProjectWorkspace(application, { principalId, projectId });
    expect(workspace.project.works).toHaveLength(2);
    expect(workspace.project.resources[0]?.latestObservationId).toMatch(/^pob_/u);
    expect(
      (await getProjectTimeline(application, { principalId, projectId })).items.length,
    ).toBeGreaterThan(3);

    const replay = await decideProjectCandidate(application, {
      principalId,
      commandId: "cmd_projectconfirm" as never,
      projectCandidateId: revised.candidate.projectCandidateId,
      expectedRevision: revised.candidate.revision,
      payload: { kind: "confirm", candidateSha256: revised.candidate.candidateSha256 },
    });
    expect(replay.candidate.status).toBe("confirmed");
    expect(replay.project?.project.projectId).toBe(projectId);
    expect(
      (
        await getProjectCandidate(application, {
          principalId,
          projectCandidateId: revised.candidate.projectCandidateId,
        })
      ).candidate.status,
    ).toBe("confirmed");
    expect(
      await getCurrentProjectCandidate(application, {
        principalId,
        sessionId: session.sessionId,
      }),
    ).toEqual({ candidate: null });

    const owner = workspace.project.participants[0];
    const work = workspace.project.works[0];
    const resource = workspace.project.resources[0];
    if (owner === undefined || work === undefined || resource === undefined) {
      throw new Error("project facts missing");
    }
    const configurationCandidate = await proposeProjectConfiguration(application, {
      principalId,
      commandId: "cmd_projectconfiguration" as never,
      projectId,
      expectedProjectRevision: workspace.project.project.revision,
      payload: {
        profileKey: "software-delivery",
        objective: "把Chat建设成可持续推进工作的产品",
        scopeIn: ["维护Chat代码和项目文档"],
        scopeOut: ["未经用户确认的高影响动作"],
        successCriteria: ["项目事实可以跨会话恢复"],
        timezone: "Asia/Shanghai",
        schedulePolicy: {
          mode: "delivery",
          plannedActualComparison: true,
          recurrenceEnabled: false,
          cadences: [],
        },
        participantIds: [owner.projectParticipantId],
        resourceBindings: [
          {
            projectResourceId: resource.projectResourceId,
            role: "source",
            required: true,
            capabilities: ["discover", "read", "version", "diff", "search"],
          },
        ],
        presentationBindings: [
          {
            capability: "work",
            providerKind: "external-work-tracker.v1",
            bindingRef: "chat:work",
            mode: "primary",
          },
          {
            capability: "code",
            providerKind: "code-workbench.v1",
            bindingRef: "chat:source",
            mode: "primary",
          },
          {
            capability: "document",
            providerKind: "embedded-document-view.v1",
            bindingRef: "chat:docs",
            mode: "primary",
          },
        ],
        terminology: { work: "开发事项" },
        requiredReads: ["AGENTS.md", "PROJECT_STATE.md"],
      },
    });
    await adoptProjectConfiguration(application, {
      principalId,
      commandId: "cmd_projectconfigurationadopt" as never,
      projectId,
      expectedProjectRevision: workspace.project.project.revision,
      expectedCandidateRevision: configurationCandidate.configuration.revision,
      payload: {
        candidateConfigurationRevisionId:
          configurationCandidate.configuration.projectConfigurationRevisionId,
        candidateRevision: configurationCandidate.configuration.revision,
        candidateSha256: configurationCandidate.configuration.sha256,
        decidedByParticipantId: owner.projectParticipantId,
        rationale: "用户审核后采用软件交付管理配置。",
      },
    });
    const opening = await getProjectAgentOpeningPacketV2(application, {
      principalId,
      query: {
        projectId,
        includeResourceContext: false,
      },
    });
    expect(opening.packet.management).toMatchObject({
      status: "ready",
      context: {
        profileRevisionSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        requiredReads: ["AGENTS.md", "PROJECT_STATE.md"],
      },
    });
    const actionWorkspace = await createProjectAction(application, {
      principalId,
      commandId: "cmd_projectaction" as never,
      projectId,
      payload: {
        workId: work.projectWorkId,
        ownerParticipantId: owner.projectParticipantId,
        title: "复核项目基线",
      },
    });
    const action = actionWorkspace.project.works
      .flatMap((item) => item.actions)
      .find((item) => item.title === "复核项目基线");
    if (action === undefined) throw new Error("action missing");
    await assignProjectAction(application, {
      principalId,
      commandId: "cmd_projectassign" as never,
      actionId: action.projectActionId,
      expectedRevision: action.revision,
      payload: { ownerParticipantId: owner.projectParticipantId },
    });
    const doing = await transitionProjectAction(application, {
      principalId,
      commandId: "cmd_projectdoing" as never,
      actionId: action.projectActionId,
      expectedRevision: action.revision + 1,
      payload: { status: "doing" },
    });
    const doingAction = doing.project.works
      .flatMap((item) => item.actions)
      .find((item) => item.projectActionId === action.projectActionId);
    expect(doingAction?.status).toBe("doing");

    const management = await beginProjectManagementCandidate(application, {
      principalId,
      commandId: "cmd_projectmanagementbegin" as never,
      payload: {
        sessionId: session.sessionId,
        projectId,
        kind: "decision",
        text: "记录决定：BMAD只作为方法输入，不成为项目事实源",
      },
    });
    expect(management.candidate).toMatchObject({
      candidateKind: "management",
      status: "under_review",
    });
    const managementReplay = await beginProjectManagementCandidate(application, {
      principalId,
      commandId: "cmd_projectmanagementbegin" as never,
      payload: {
        sessionId: session.sessionId,
        projectId,
        kind: "decision",
        text: "记录决定：BMAD只作为方法输入，不成为项目事实源",
      },
    });
    expect(managementReplay.candidate.projectCandidateId).toBe(
      management.candidate.projectCandidateId,
    );
    if (
      management.candidate.candidateKind !== "management" ||
      management.candidate.status !== "under_review"
    ) {
      throw new Error("management candidate missing");
    }
    const managementConfirmed = await decideProjectManagementCandidate(application, {
      principalId,
      commandId: "cmd_projectmanagementconfirm" as never,
      projectCandidateId: management.candidate.projectCandidateId,
      expectedRevision: management.candidate.revision,
      payload: {
        kind: "confirm",
        candidateSha256: management.candidate.candidateSha256,
      },
    });
    expect(managementConfirmed.candidate.status).toBe("confirmed");
    expect(
      managementConfirmed.project.decisions.some(
        (item) => item.choice === "BMAD只作为方法输入，不成为项目事实源",
      ),
    ).toBe(true);

    await recordProjectDecision(application, {
      principalId,
      commandId: "cmd_projectdecision" as never,
      projectId,
      expectedRevision: workspace.project.project.revision,
      payload: {
        question: "BMAD在本项目中是什么角色？",
        options: ["强制流程", "方法输入"],
        choice: "方法输入",
        rationale: "核心目标是帮助用户管理和推进真实项目",
        decidedByParticipantId: owner.projectParticipantId,
      },
    });
    await recordProjectContribution(application, {
      principalId,
      commandId: "cmd_projectcontribution" as never,
      projectId,
      payload: {
        participantId: owner.projectParticipantId,
        workId: work.projectWorkId,
        kind: "coordination",
        summary: "确认项目方法边界",
        evidenceIds: [],
        occurredAt: NOW,
      },
    });
    await observeProjectResource(application, {
      principalId,
      commandId: "cmd_projectobserve" as never,
      projectId,
      resourceId: resource.projectResourceId,
    });
    const staleManagement = await beginProjectManagementCandidate(application, {
      principalId,
      commandId: "cmd_projectstalebegin" as never,
      payload: {
        sessionId: session.sessionId,
        projectId,
        kind: "contribution",
        text: "记录贡献：验证旧Project revision失败关闭",
      },
    });
    if (
      staleManagement.candidate.candidateKind !== "management" ||
      staleManagement.candidate.status !== "under_review"
    ) {
      throw new Error("stale management candidate missing");
    }
    const archived = await setProjectArchiveStatus(application, {
      principalId,
      commandId: "cmd_projectarchive" as never,
      projectId,
      expectedRevision: workspace.project.project.revision,
      payload: { status: "archived" },
    });
    expect(archived.project.project.status).toBe("archived");
    await expect(
      createProjectAction(application, {
        principalId,
        commandId: "cmd_projectarchivedwrite" as never,
        projectId,
        payload: {
          workId: work.projectWorkId,
          ownerParticipantId: owner.projectParticipantId,
          title: "归档后不允许新增",
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const restored = await setProjectArchiveStatus(application, {
      principalId,
      commandId: "cmd_projectrestore" as never,
      projectId,
      expectedRevision: archived.project.project.revision,
      payload: { status: "active" },
    });
    expect(restored.project.project.status).toBe("active");
    const paused = await transitionProjectLifecycle(application, {
      principalId,
      commandId: "cmd_projectpause" as never,
      projectId,
      expectedRevision: restored.project.project.revision,
      payload: {
        status: "paused",
        reason: "等待外部确认，暂时停止普通推进",
        decidedByParticipantId: owner.projectParticipantId,
        evidenceIds: [],
      },
    });
    expect(paused.project.project.status).toBe("paused");
    const resumed = await transitionProjectLifecycle(application, {
      principalId,
      commandId: "cmd_projectresume" as never,
      projectId,
      expectedRevision: paused.project.project.revision,
      payload: {
        status: "active",
        reason: "外部确认完成，恢复推进",
        decidedByParticipantId: owner.projectParticipantId,
        evidenceIds: [],
      },
    });
    expect(resumed.project.project.status).toBe("active");
    await expect(
      decideProjectManagementCandidate(application, {
        principalId,
        commandId: "cmd_projectstaleconfirm" as never,
        projectCandidateId: staleManagement.candidate.projectCandidateId,
        expectedRevision: staleManagement.candidate.revision,
        payload: {
          kind: "confirm",
          candidateSha256: staleManagement.candidate.candidateSha256,
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const staleRejected = await decideProjectManagementCandidate(application, {
      principalId,
      commandId: "cmd_projectstalereject" as never,
      projectCandidateId: staleManagement.candidate.projectCandidateId,
      expectedRevision: staleManagement.candidate.revision,
      payload: {
        kind: "reject",
        candidateSha256: staleManagement.candidate.candidateSha256,
        reason: "Project已经变化，关闭旧候选",
      },
    });
    expect(staleRejected.candidate.status).toBe("rejected");

    const concurrentManagement = await beginProjectManagementCandidate(application, {
      principalId,
      commandId: "cmd_projectracebegin" as never,
      payload: {
        sessionId: session.sessionId,
        projectId,
        kind: "action",
        text: "新增待办：并发确认只能提交一次",
      },
    });
    if (
      concurrentManagement.candidate.candidateKind !== "management" ||
      concurrentManagement.candidate.status !== "under_review"
    ) {
      throw new Error("concurrent management candidate missing");
    }
    const managementAttempts = await Promise.allSettled([
      decideProjectManagementCandidate(application, {
        principalId,
        commandId: "cmd_projectmanagementrace1" as never,
        projectCandidateId: concurrentManagement.candidate.projectCandidateId,
        expectedRevision: concurrentManagement.candidate.revision,
        payload: {
          kind: "confirm",
          candidateSha256: concurrentManagement.candidate.candidateSha256,
        },
      }),
      decideProjectManagementCandidate(application, {
        principalId,
        commandId: "cmd_projectmanagementrace2" as never,
        projectCandidateId: concurrentManagement.candidate.projectCandidateId,
        expectedRevision: concurrentManagement.candidate.revision,
        payload: {
          kind: "confirm",
          candidateSha256: concurrentManagement.candidate.candidateSha256,
        },
      }),
    ]);
    expect(managementAttempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(managementAttempts.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("旧revision、旧Hash和并发确认失败关闭", async () => {
    const application = await deps();
    const principalId = "usr_projectowner" as never;
    const { session } = await createProductSession(application, {
      principalId,
      commandId: "cmd_projectsession2" as never,
      payload: {},
    });
    const begun = await beginProjectIntake(application, {
      principalId,
      commandId: "cmd_projectbegin2" as never,
      payload: { sessionId: session.sessionId, text: "建立Chat项目", rootId: "root_chat" },
    });
    const prepared = await prepareProjectCandidateForReview(application, {
      commandId: "cmd_projectprepare2" as never,
      projectCandidateId: begun.candidate.projectCandidateId,
      expectedRevision: 1,
    });
    if (
      prepared.candidate.candidateKind !== "intake" ||
      prepared.candidate.status !== "under_review"
    ) {
      throw new Error("candidate not ready");
    }
    await expect(
      decideProjectCandidate(application, {
        principalId,
        commandId: "cmd_projectbad" as never,
        projectCandidateId: prepared.candidate.projectCandidateId,
        expectedRevision: prepared.candidate.revision,
        payload: { kind: "confirm", candidateSha256: "0".repeat(64) as never },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const attempts = await Promise.allSettled([
      decideProjectCandidate(application, {
        principalId,
        commandId: "cmd_projectrace1" as never,
        projectCandidateId: prepared.candidate.projectCandidateId,
        expectedRevision: prepared.candidate.revision,
        payload: { kind: "confirm", candidateSha256: prepared.candidate.candidateSha256 },
      }),
      decideProjectCandidate(application, {
        principalId,
        commandId: "cmd_projectrace2" as never,
        projectCandidateId: prepared.candidate.projectCandidateId,
        expectedRevision: prepared.candidate.revision,
        payload: { kind: "confirm", candidateSha256: prepared.candidate.candidateSha256 },
      }),
    ]);
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
  });

  it("Provider失败只调用一次并提交可恢复的failed Candidate", async () => {
    const base = await deps();
    let providerCalls = 0;
    const application: ApplicationDeps = {
      ...base,
      projectIntakeUnderstanding: {
        describe: () => ({
          profileVersion: "test.project-model.v1",
          providerName: "test-provider",
          modelId: "test-model",
          promptTemplateVersion: "project-intake-understanding.v1",
          endpointHost: "models.example.test",
        }),
        understand: async () => {
          providerCalls += 1;
          throw Object.assign(new Error("auth failed"), { code: "provider.auth_failed" });
        },
      },
    };
    const principalId = "usr_projectowner" as never;
    const { session } = await createProductSession(application, {
      principalId,
      commandId: "cmd_projectfailsession" as never,
      payload: {},
    });
    const begun = await beginProjectIntake(application, {
      principalId,
      commandId: "cmd_projectfailbegin" as never,
      payload: { sessionId: session.sessionId, text: "建立失败测试项目", rootId: "root_chat" },
    });
    await expect(
      prepareProjectCandidateForReview(application, {
        commandId: "cmd_projectfailprepare" as never,
        projectCandidateId: begun.candidate.projectCandidateId,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "provider_auth_failed", retryable: false });
    expect(providerCalls).toBe(1);
    const failed = await getProjectCandidate(application, {
      principalId,
      projectCandidateId: begun.candidate.projectCandidateId,
    });
    expect(failed.candidate).toMatchObject({
      status: "failed",
      failureCode: "provider.auth_failed",
      revision: 2,
    });
    await expect(
      prepareProjectCandidateForReview(application, {
        commandId: "cmd_projectfailprepare" as never,
        projectCandidateId: begun.candidate.projectCandidateId,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(providerCalls).toBe(1);
  });
});

describe("PS2.1 Project Advancement Application纵向链", () => {
  it("Queued→真实理解Port→修订/CAS→原子Stage、Milestone与Update", async () => {
    const application = await deps();
    const principalId = "usr_advancementowner" as never;
    const { session } = await createProductSession(application, {
      principalId,
      commandId: "cmd_advancesession" as never,
      payload: { title: "Project Advancement" },
    });
    const intake = await beginProjectIntake(application, {
      principalId,
      commandId: "cmd_advanceintake" as never,
      payload: { sessionId: session.sessionId, text: "建立Chat项目", rootId: "root_chat" },
    });
    const intakePrepared = await prepareProjectCandidateForReview(application, {
      commandId: "cmd_advanceintakeprepare" as never,
      projectCandidateId: intake.candidate.projectCandidateId,
      expectedRevision: 1,
    });
    if (
      intakePrepared.candidate.candidateKind !== "intake" ||
      intakePrepared.candidate.status !== "under_review"
    ) {
      throw new Error("intake candidate missing");
    }
    const intakeConfirmed = await decideProjectCandidate(application, {
      principalId,
      commandId: "cmd_advanceintakeconfirm" as never,
      projectCandidateId: intakePrepared.candidate.projectCandidateId,
      expectedRevision: intakePrepared.candidate.revision,
      payload: {
        kind: "confirm",
        candidateSha256: intakePrepared.candidate.candidateSha256,
      },
    });
    const projectId = intakeConfirmed.project?.project.projectId;
    if (projectId === undefined) throw new Error("project missing");

    const begun = await beginProjectAdvancement(application, {
      principalId,
      commandId: "cmd_advancebegin" as never,
      payload: {
        sessionId: session.sessionId,
        projectId,
        text: "进入可用项目推进阶段，先完成PS2.1并发布正常进展更新",
      },
    });
    expect(begun.candidate).toMatchObject({ candidateKind: "advancement", status: "queued" });
    const prepared = await prepareProjectAdvancementCandidate(application, {
      commandId: "cmd_advanceprepare" as never,
      projectCandidateId: begun.candidate.projectCandidateId,
      expectedRevision: 1,
    });
    if (
      prepared.candidate.candidateKind !== "advancement" ||
      prepared.candidate.status !== "under_review"
    ) {
      throw new Error("advancement candidate missing");
    }
    expect(prepared.candidate.proposal.update.health).toBe("on_track");

    const revised = await decideProjectAdvancementCandidate(application, {
      principalId,
      commandId: "cmd_advancerevise" as never,
      projectCandidateId: prepared.candidate.projectCandidateId,
      expectedRevision: prepared.candidate.revision,
      payload: {
        kind: "revise",
        candidateSha256: prepared.candidate.candidateSha256,
        proposal: {
          ...prepared.candidate.proposal,
          update: {
            ...prepared.candidate.proposal.update,
            health: "at_risk",
            blockers: ["真实浏览器门尚未完成"],
          },
        },
      },
    });
    if (
      revised.candidate.candidateKind !== "advancement" ||
      revised.candidate.status !== "under_review"
    ) {
      throw new Error("advancement candidate not revised");
    }
    await expect(
      decideProjectAdvancementCandidate(application, {
        principalId,
        commandId: "cmd_advanceoldconfirm" as never,
        projectCandidateId: revised.candidate.projectCandidateId,
        expectedRevision: prepared.candidate.revision,
        payload: { kind: "confirm", candidateSha256: prepared.candidate.candidateSha256 },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const confirmed = await decideProjectAdvancementCandidate(application, {
      principalId,
      commandId: "cmd_advanceconfirm" as never,
      projectCandidateId: revised.candidate.projectCandidateId,
      expectedRevision: revised.candidate.revision,
      payload: { kind: "confirm", candidateSha256: revised.candidate.candidateSha256 },
    });
    expect(confirmed.candidate.status).toBe("confirmed");
    expect(confirmed.project.stage.name).toBe("可用的项目推进");
    expect(confirmed.project.milestones).toHaveLength(1);
    expect(confirmed.project.latestUpdate).toMatchObject({
      health: "at_risk",
      blockers: ["真实浏览器门尚未完成"],
    });

    const { snapshot } = await application.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.projectUpdates)).toHaveLength(1);
    expect(Object.values(snapshot.entities.projectMilestones)).toHaveLength(1);
    expect(
      Object.values(snapshot.outbox).some(
        (entry) => entry.kind === "project_advancement_resume" && entry.status === "pending",
      ),
    ).toBe(true);

    const owner = Object.values(snapshot.entities.projectParticipants).find(
      (item) => item.projectId === projectId && item.principalId === principalId,
    );
    const evidence = Object.values(snapshot.entities.projectEvidence).find(
      (item) => item.projectId === projectId,
    );
    const milestone = Object.values(snapshot.entities.projectMilestones).find(
      (item) => item.projectId === projectId,
    );
    if (owner === undefined || evidence === undefined || milestone === undefined) {
      throw new Error("advancement fixtures missing");
    }

    const review = await transitionProjectStage(application, {
      principalId,
      commandId: "cmd_advancestagereview" as never,
      projectStageId: confirmed.project.stage.projectStageId,
      expectedRevision: confirmed.project.stage.revision,
      payload: {
        status: "review",
        reason: "进入阶段评审",
        decidedByParticipantId: owner.projectParticipantId,
        evidenceIds: [],
      },
    });
    await expect(
      transitionProjectStage(application, {
        principalId,
        commandId: "cmd_advancestagecomplete_without_evidence" as never,
        projectStageId: review.stage.projectStageId,
        expectedRevision: review.stage.revision,
        payload: {
          status: "completed",
          reason: "没有证据不能完成",
          decidedByParticipantId: owner.projectParticipantId,
          evidenceIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: "project_stage_evidence_required" });
    const completed = await transitionProjectStage(application, {
      principalId,
      commandId: "cmd_advancestagecomplete" as never,
      projectStageId: review.stage.projectStageId,
      expectedRevision: review.stage.revision,
      payload: {
        status: "completed",
        reason: "已有资源观察证据，阶段评审通过",
        decidedByParticipantId: owner.projectParticipantId,
        evidenceIds: [evidence.projectEvidenceId],
      },
    });
    expect(completed.stage.status).toBe("completed");

    const milestoneResult = await transitionProjectMilestone(application, {
      principalId,
      commandId: "cmd_advancemilestoneachieve" as never,
      projectMilestoneId: milestone.projectMilestoneId,
      expectedRevision: milestone.revision,
      payload: {
        status: "achieved",
        reason: "已绑定可核验资源观察",
        decidedByParticipantId: owner.projectParticipantId,
        evidenceIds: [evidence.projectEvidenceId],
      },
    });
    expect(milestoneResult.milestones[0]?.status).toBe("achieved");
    const timeline = await getProjectTimeline(application, { principalId, projectId });
    expect(timeline.items.some((item) => item.kind === "state_transition")).toBe(true);
    expect(timeline.items.some((item) => item.kind === "project_update")).toBe(true);
  });
});

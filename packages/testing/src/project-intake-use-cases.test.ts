import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  beginProjectIntake,
  assignProjectAction,
  createProjectAction,
  createProductSession,
  decideProjectCandidate,
  getProjectCandidate,
  getCurrentProjectCandidate,
  getProjectTimeline,
  getProjectWorkspace,
  listProjects,
  observeProjectResource,
  prepareProjectCandidateForReview,
  recordProjectContribution,
  recordProjectDecision,
  setProjectArchiveStatus,
  transitionProjectAction,
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
    if (prepared.candidate.status !== "under_review") throw new Error("candidate not ready");
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
    if (revised.candidate.status !== "under_review") throw new Error("candidate not revised");

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
    if (prepared.candidate.status !== "under_review") throw new Error("candidate not ready");
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
});

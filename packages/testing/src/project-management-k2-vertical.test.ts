import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptProjectConfiguration,
  captureProjectNeed,
  compileProjectAgentContext,
  createContentProductionProject,
  evaluateProjectMaintenance,
  getProjectAgentOpeningPacket,
  getProjectHome,
  proposeProjectConfiguration,
  proposeProjectRequirement,
  type ApplicationDeps,
} from "@chat/application";
import type { PrincipalId, ProjectParticipantId } from "@chat/contracts";
import { JsonProductStore } from "@chat/product-store-json";

const PRINCIPAL = "usr_k2vertical" as PrincipalId;
const NOW = "2026-08-25T12:00:00.000Z";

function command(label: string) {
  return `cmd_${label}` as never;
}

function projectIds() {
  let sequence = 0;
  const allocate = (prefix: string) => () => `${prefix}_${String(++sequence)}k2` as never;
  return {
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
  } as NonNullable<ApplicationDeps["projectIds"]>;
}

function deps(store: JsonProductStore): ApplicationDeps {
  return {
    store,
    now: () => NOW,
    ids: new Proxy({}, { get: () => () => "unused" }) as ApplicationDeps["ids"],
    projectIds: projectIds(),
    projectRoots: {
      list: () => [
        {
          rootId: "root_contentlab",
          displayName: "Ziji Content Lab",
          enabledAdapters: ["local-git-workspace.v1", "content-lab-resource.v1"],
        },
      ],
      observe: async () => {
        throw new Error("该纵向不读取真实客户目录");
      },
    },
  };
}

describe("K2真实Product Store纵向", () => {
  it("Content Lab采用Profile、记录对象并在重启后恢复用户/Agent/Maintenance投影", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-k2-vertical-"));
    const filePath = join(directory, "product-store.json");
    const store = await JsonProductStore.open({ filePath, now: () => NOW });
    const application = deps(store);
    const created = await createContentProductionProject(application, {
      principalId: PRINCIPAL,
      commandId: command("k2create"),
      payload: {
        rootId: "root_contentlab",
        name: "Content Lab",
        summary: "把感兴趣的视频转译成中文内容。",
        goal: "持续发布内容并用真实案例优化工作流。",
        scopeIn: ["来源、内容Revision、审核、发布、案例、经验"],
        scopeOut: ["未经用户确认的自动发布"],
        successCriteria: ["发布历史可追溯", "工作流优化有案例和证据"],
      },
    });
    const projectId = created.project.project.projectId;
    const owner = created.project.participants.find((item) => item.kind === "human");
    const resource = created.project.resources[0];
    if (owner === undefined || resource === undefined) throw new Error("基础Project对象缺失");

    const proposed = await proposeProjectConfiguration(application, {
      principalId: PRINCIPAL,
      commandId: command("k2config"),
      projectId,
      expectedProjectRevision: created.project.project.revision,
      payload: {
        profileKey: "content-production",
        objective: "持续生产、发布并优化中文内容工作流。",
        scopeIn: ["来源、内容Revision、审核、发布、案例、经验"],
        scopeOut: ["未经用户确认的自动发布"],
        successCriteria: ["发布历史可追溯", "工作流优化有案例和证据"],
        timezone: "Asia/Shanghai",
        schedulePolicy: {
          mode: "continuous",
          plannedActualComparison: true,
          recurrenceEnabled: true,
          cadences: [
            {
              key: "publication-review",
              trigger: "weekly",
              action: "review",
              required: true,
            },
          ],
        },
        participantIds: [owner.projectParticipantId],
        resourceBindings: [
          {
            projectResourceId: resource.projectResourceId,
            role: "content_assets",
            required: true,
            capabilities: ["discover", "read", "write", "version", "diff", "search", "render"],
          },
        ],
        presentationBindings: [
          {
            capability: "document",
            providerKind: "embedded-document-view.v1",
            bindingRef: "content-lab:documents",
            mode: "primary",
          },
          {
            capability: "work",
            providerKind: "plane-work-tracking.v1",
            bindingRef: "content-lab:work",
            mode: "primary",
          },
        ],
        terminology: { publication: "发布", practice: "工作流经验" },
        requiredReads: ["AGENTS.md", "项目地图"],
      },
    });
    const adopted = await adoptProjectConfiguration(application, {
      principalId: PRINCIPAL,
      commandId: command("k2adopt"),
      projectId,
      expectedProjectRevision: created.project.project.revision,
      expectedCandidateRevision: proposed.configuration.revision,
      payload: {
        candidateConfigurationRevisionId: proposed.configuration.projectConfigurationRevisionId,
        candidateRevision: proposed.configuration.revision,
        candidateSha256: proposed.configuration.sha256,
        decidedByParticipantId: owner.projectParticipantId as ProjectParticipantId,
        rationale: "用户确认Content Lab按内容生产方式管理。",
      },
    });
    const captured = await captureProjectNeed(application, {
      principalId: PRINCIPAL,
      commandId: command("k2need"),
      projectId,
      expectedProjectRevision: created.project.project.revision,
      payload: {
        statement: "用户需要看到昨天、前天发布了什么以及内容的修改历史。",
        origin: "user",
        occurredAt: NOW,
      },
    });
    await proposeProjectRequirement(application, {
      principalId: PRINCIPAL,
      commandId: command("k2requirement"),
      projectId,
      expectedProjectRevision: created.project.project.revision,
      payload: {
        needIds: [captured.need.projectNeedId],
        kind: "outcome",
        statement: "内容时间线必须展示来源、Revision、审核、发布回执和经验归档。",
        acceptanceCriteria: ["重启后仍能按Event和Artifact Revision恢复历史"],
      },
    });

    const beforeRestartHome = await getProjectHome(application, {
      principalId: PRINCIPAL,
      projectId,
    });
    expect(beforeRestartHome.projectHome.profile.profileKey).toBe("content-production");
    expect(beforeRestartHome.projectHome.recentEvents).toHaveLength(4);

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    const recovered = deps(reopened);
    const home = await getProjectHome(recovered, { principalId: PRINCIPAL, projectId });
    const context = await compileProjectAgentContext(recovered, {
      principalId: PRINCIPAL,
      projectId,
      purpose: "project_opening",
    });
    const maintenance = await evaluateProjectMaintenance(recovered, {
      principalId: PRINCIPAL,
      projectId,
      trigger: "agent_started",
    });
    const opening = await getProjectAgentOpeningPacket(recovered, {
      principalId: PRINCIPAL,
      query: {
        projectId,
        includeResourceContext: false,
        refreshPlane: false,
      },
    });
    expect(home.projectHome.configuration.sha256).toBe(adopted.configuration.sha256);
    expect(home.projectHome.configuration.schedulePolicy.mode).toBe("continuous");
    expect(home.projectHome.objectCounts.need).toBe(1);
    expect(home.projectHome.objectCounts.requirement).toBe(1);
    expect(context.context.configurationRevisionSha256).toBe(adopted.configuration.sha256);
    expect(context.context.schedulePolicy.cadences.map((cadence) => cadence.key)).toContain(
      "publication-review",
    );
    expect(context.context.requiredReads).toEqual(["AGENTS.md", "项目地图"]);
    expect(maintenance.maintenance.items.map((item) => item.action)).toContain("observe");
    expect(opening.packet.management).toMatchObject({
      status: "ready",
      context: { purpose: "project_opening" },
      maintenance: { trigger: "agent_started" },
    });

    const snapshot = (await reopened.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(snapshot.entities.projectProfileRevisions)).toHaveLength(1);
    expect(Object.values(snapshot.entities.projectConfigurationRevisions)).toHaveLength(2);
    expect(Object.values(snapshot.entities.projectNeeds)).toHaveLength(1);
    expect(Object.values(snapshot.entities.projectRequirements)).toHaveLength(1);
    expect(Object.values(snapshot.entities.projectEvents)).toHaveLength(4);
  });
});

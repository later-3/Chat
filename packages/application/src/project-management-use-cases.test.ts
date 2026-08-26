import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  type PrincipalId,
  type ProductSnapshot,
  type ProjectId,
  type ProjectParticipantId,
  type ProjectResourceId,
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
  adoptProjectConfiguration,
  captureProjectNeed,
  proposeProjectConfiguration,
  proposeProjectRequirement,
  registerBuiltInProjectProfile,
} from "./project-management-use-cases.js";
import {
  compileProjectAgentContext,
  evaluateProjectMaintenance,
  getProjectHome,
} from "./project-management-query-use-cases.js";

const PRINCIPAL = "usr_projectkernel" as PrincipalId;
const NOW = "2026-08-25T12:00:00.000Z";

class InMemoryProductStore implements ProductStorePort {
  #snapshot: ProductSnapshot;
  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }
  async read() {
    return { snapshot: structuredClone(this.#snapshot) };
  }
  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const receipt = this.#snapshot.commandReceipts[transaction.commandId];
    if (receipt !== undefined) {
      if (
        receipt.commandType !== transaction.commandType ||
        receipt.requestSha256 !== transaction.requestSha256
      ) {
        throw new CommandIdReusedError(transaction.commandId);
      }
      return {
        storeRevision: this.#snapshot.storeRevision,
        resultRefs: receipt.resultRefs,
        replayed: true,
      };
    }
    const draft = structuredClone(this.#snapshot);
    const mutation = transaction.mutate(draft);
    draft.storeRevision += 1;
    draft.committedAt = NOW;
    draft.commandReceipts[transaction.commandId] = {
      commandId: transaction.commandId,
      commandType: transaction.commandType,
      requestSha256: transaction.requestSha256 as never,
      resultRefs: mutation.resultRefs,
      committedStoreRevision: draft.storeRevision,
      createdAt: NOW,
    };
    this.#snapshot = draft;
    return { storeRevision: draft.storeRevision, resultRefs: mutation.resultRefs, replayed: false };
  }
}

const profiles = [
  {
    projectId: "prj_chatkernel1",
    participantId: "ppt_chatkernel1",
    resourceId: "prs_chatkernel1",
    name: "Chat",
    profileKey: "software-delivery",
    methodProfileId: "software-delivery.v1",
    need: "用户需要Chat以对话推进和治理不同类型的项目。",
    requirement: "Agent恢复上下文时必须读取精确Profile、Configuration和历史事件。",
    schedulePolicy: {
      mode: "delivery",
      plannedActualComparison: true,
      recurrenceEnabled: false,
      cadences: [],
    },
    bindings: [
      ["code", "code-workbench.v1"],
      ["document", "embedded-document-view.v1"],
      ["work", "external-work-tracker.v1"],
    ],
  },
  {
    projectId: "prj_contentkernel1",
    participantId: "ppt_contentkernel1",
    resourceId: "prs_contentkernel1",
    name: "Content Lab",
    profileKey: "content-production",
    methodProfileId: "content-production.v1",
    need: "用户需要把外语视频转译成可审核、可发布的中文内容。",
    requirement: "每次内容Revision都必须能追溯来源、审核和发布结果。",
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
    bindings: [
      ["document", "embedded-document-view.v1"],
      ["media", "media-preview.v1"],
      ["work", "external-work-tracker.v1"],
    ],
  },
  {
    projectId: "prj_learningkernel1",
    participantId: "ppt_learningkernel1",
    resourceId: "prs_learningkernel1",
    name: "AI学习",
    profileKey: "learning",
    methodProfileId: "small-project.v1",
    need: "用户希望四个月后达到能够跳槽并涨薪50%的AI工程能力。",
    requirement: "掌握度只能由回忆、练习、项目或测评证据确认。",
    schedulePolicy: {
      mode: "deadline",
      targetAt: "2026-12-25T12:00:00.000Z",
      plannedActualComparison: true,
      recurrenceEnabled: true,
      cadences: [
        {
          key: "weekly-learning-review",
          trigger: "weekly",
          action: "review",
          required: true,
        },
        {
          key: "target-attention",
          trigger: "deadline",
          action: "attention",
          required: true,
        },
      ],
    },
    bindings: [
      ["document", "embedded-document-view.v1"],
      ["calendar", "calendar-view.v1"],
      ["report", "learning-report.v1"],
    ],
  },
  {
    projectId: "prj_dailykernel1",
    participantId: "ppt_dailykernel1",
    resourceId: "prs_dailykernel1",
    name: "个人日报",
    profileKey: "personal-journal",
    methodProfileId: "lightweight.v1",
    need: "用户需要低摩擦记录每天发生的事实并形成周报。",
    requirement: "记录不能自动被解释为承诺，跨项目行动必须等待用户确认。",
    schedulePolicy: {
      mode: "cadence",
      plannedActualComparison: true,
      recurrenceEnabled: true,
      cadences: [
        { key: "daily-close", trigger: "daily", action: "report", required: true },
        { key: "weekly-review", trigger: "weekly", action: "review", required: true },
        { key: "monthly-trend", trigger: "monthly", action: "report", required: false },
      ],
    },
    bindings: [
      ["document", "embedded-document-view.v1"],
      ["timeline", "timeline-view.v1"],
      ["report", "personal-report.v1"],
    ],
  },
  {
    projectId: "prj_philosophykernel1",
    participantId: "ppt_philosophykernel1",
    resourceId: "prs_philosophykernel1",
    name: "长期哲学阅读",
    profileKey: "learning",
    methodProfileId: "small-project.v1",
    need: "用户希望长期阅读哲学原典并逐步建立概念关系，不设完成期限。",
    requirement: "理解只能由复述、比较、写作或讨论证据支持。",
    schedulePolicy: {
      mode: "continuous",
      plannedActualComparison: false,
      recurrenceEnabled: false,
      cadences: [],
    },
    bindings: [
      ["document", "embedded-document-view.v1"],
      ["timeline", "timeline-view.v1"],
      ["relation", "knowledge-relation-view.v1"],
    ],
  },
] as const;

function seedProject(snapshot: ProductSnapshot, input: (typeof profiles)[number]): void {
  const projectId = input.projectId as ProjectId;
  const participantId = input.participantId as ProjectParticipantId;
  const resourceId = input.resourceId as ProjectResourceId;
  const projectKey = input.projectId.replace(/^prj_/u, "");
  const methodId = `pms_${projectKey}` as never;
  const stageId = `pst_${projectKey}` as never;
  const policies = compileProjectMethodSnapshotPolicies(input.methodProfileId);
  const rationale = "旧Project聚合保留兼容壳；全项目生命周期由Profile/Configuration承担。";
  snapshot.entities.projectMethodSnapshots[methodId] = {
    schemaVersion: "project-method-snapshot.v3",
    projectMethodSnapshotId: methodId,
    projectId,
    profileId: input.methodProfileId,
    rationale,
    policies,
    source: "migrated_v1",
    sha256: computeProjectMethodSnapshotSha256({
      profileId: input.methodProfileId,
      rationale,
      policies,
      source: "migrated_v1",
    }) as never,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projectStages[stageId] = {
    schemaVersion: "project-stage.v2",
    projectStageId: stageId,
    projectId,
    methodSnapshotId: methodId,
    key: "ongoing",
    name: "持续推进",
    goal: input.need,
    successCriteria: [input.requirement],
    status: "active",
    sequence: 1,
    startedAt: NOW,
    completionEvidenceIds: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projects[projectId] = {
    schemaVersion: "project.v2",
    projectId,
    ownerPrincipalId: PRINCIPAL,
    name: input.name,
    summary: input.need,
    goal: input.need,
    scopeIn: [input.need],
    scopeOut: ["未经用户确认的高影响动作"],
    successCriteria: [input.requirement],
    status: "active",
    methodSnapshotId: methodId,
    currentStageId: stageId,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projectParticipants[participantId] = {
    schemaVersion: "project-participant.v1",
    projectParticipantId: participantId,
    projectId,
    kind: "human",
    principalId: PRINCIPAL,
    displayName: "项目所有者",
    role: "owner",
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projectResources[resourceId] = {
    schemaVersion: "project-resource.v1",
    projectResourceId: resourceId,
    projectId,
    rootId: `root_${projectKey}`,
    displayName: `${input.name}受管资源`,
    kind: "workspace",
    enabledAdapters: ["local-git-workspace.v1"],
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function command(label: string) {
  return `cmd_${label}` as never;
}

function deps() {
  const snapshot = createEmptySnapshot(NOW);
  for (const profile of profiles) seedProject(snapshot, profile);
  return {
    store: new InMemoryProductStore(snapshot),
    now: () => NOW,
    ids: new Proxy({}, { get: () => () => "unused" }) as ApplicationDeps["ids"],
  } satisfies ApplicationDeps;
}

describe("全项目生命周期Application纵向", () => {
  it("四个通用类别支撑五个具体Project，并复用同一采用、对象、View、Context和Maintenance链", async () => {
    const application = deps();
    const learningProfileHashes: string[] = [];
    const learningScheduleModes: string[] = [];
    for (const [index, scenario] of profiles.entries()) {
      const registered = await registerBuiltInProjectProfile(application, {
        commandId: command(`profile${String(index)}`),
        profileKey: scenario.profileKey,
      });
      if (scenario.profileKey === "learning") {
        learningProfileHashes.push(registered.profile.sha256);
      }
      const proposed = await proposeProjectConfiguration(application, {
        principalId: PRINCIPAL,
        commandId: command(`config${String(index)}`),
        projectId: scenario.projectId as ProjectId,
        expectedProjectRevision: 1,
        payload: {
          profileKey: scenario.profileKey,
          objective: scenario.need,
          scopeIn: [scenario.need],
          scopeOut: ["未经用户确认的高影响动作"],
          successCriteria: [scenario.requirement],
          timezone: "Asia/Shanghai",
          schedulePolicy: {
            ...scenario.schedulePolicy,
            cadences: scenario.schedulePolicy.cadences.map((cadence) => ({ ...cadence })),
          },
          participantIds: [scenario.participantId as ProjectParticipantId],
          resourceBindings: [
            {
              projectResourceId: scenario.resourceId as ProjectResourceId,
              role: scenario.profileKey === "software-delivery" ? "source" : "project_assets",
              required: true,
              capabilities: ["discover", "read", "version", "diff", "search"],
            },
          ],
          presentationBindings: scenario.bindings.map(([capability, providerKind]) => ({
            capability,
            providerKind,
            bindingRef: `${scenario.projectId}:${capability}`,
            mode: "primary" as const,
          })),
          terminology: {},
          requiredReads: ["AGENTS.md", "PROJECT_STATE.md"],
        },
      });
      const adopted = await adoptProjectConfiguration(application, {
        principalId: PRINCIPAL,
        commandId: command(`adopt${String(index)}`),
        projectId: scenario.projectId as ProjectId,
        expectedProjectRevision: 1,
        expectedCandidateRevision: 1,
        payload: {
          candidateConfigurationRevisionId: proposed.configuration.projectConfigurationRevisionId,
          candidateRevision: proposed.configuration.revision,
          candidateSha256: proposed.configuration.sha256,
          decidedByParticipantId: scenario.participantId as ProjectParticipantId,
          rationale: "用户审核后采用当前项目类型和资源/呈现配置。",
        },
      });
      expect(adopted.configuration.status).toBe("adopted");
      if (scenario.profileKey === "learning") {
        learningScheduleModes.push(adopted.configuration.schedulePolicy.mode);
      }

      const captured = await captureProjectNeed(application, {
        principalId: PRINCIPAL,
        commandId: command(`need${String(index)}`),
        projectId: scenario.projectId as ProjectId,
        expectedProjectRevision: 1,
        payload: { statement: scenario.need, origin: "user", occurredAt: NOW },
      });
      const requirement = await proposeProjectRequirement(application, {
        principalId: PRINCIPAL,
        commandId: command(`requirement${String(index)}`),
        projectId: scenario.projectId as ProjectId,
        expectedProjectRevision: 1,
        payload: {
          needIds: [captured.need.projectNeedId],
          kind: "outcome",
          statement: scenario.requirement,
          acceptanceCriteria: [scenario.requirement],
        },
      });
      expect(requirement.requirement.status).toBe("proposed");

      const home = await getProjectHome(application, {
        principalId: PRINCIPAL,
        projectId: scenario.projectId,
      });
      expect(home.projectHome.profile.profileKey).toBe(scenario.profileKey);
      expect(home.projectHome.configuration.schedulePolicy.mode).toBe(scenario.schedulePolicy.mode);
      expect(home.projectHome.objectCounts.need).toBe(1);
      expect(home.projectHome.objectCounts.requirement).toBe(1);
      expect(home.projectHome.presentationSurfaces.map((surface) => surface.capability)).toEqual(
        expect.arrayContaining(scenario.bindings.map(([capability]) => capability)),
      );

      for (const purpose of [
        "project_opening",
        "work_execution",
        "delta",
        "review",
        "handoff",
        "maintenance",
      ] as const) {
        const context = await compileProjectAgentContext(application, {
          principalId: PRINCIPAL,
          projectId: scenario.projectId,
          purpose,
        });
        expect(context.context.purpose).toBe(purpose);
        expect(context.context.configurationRevisionSha256).toBe(adopted.configuration.sha256);
        expect(context.context.schedulePolicy.mode).toBe(scenario.schedulePolicy.mode);
        expect(context.context.sha256).toMatch(/^[a-f0-9]{64}$/u);
      }

      const trigger = scenario.profileKey === "personal-journal" ? "daily" : "agent_started";
      const maintenance = await evaluateProjectMaintenance(application, {
        principalId: PRINCIPAL,
        projectId: scenario.projectId,
        trigger,
      });
      expect(maintenance.maintenance.items.length).toBeGreaterThan(0);
    }
    expect(new Set(learningProfileHashes).size).toBe(1);
    expect(learningScheduleModes).toEqual(["deadline", "continuous"]);
  });

  it("Agent提出的Need保持captured，不能自动变成Commitment", async () => {
    const application = deps();
    const scenario = profiles[0];
    const captured = await captureProjectNeed(application, {
      principalId: PRINCIPAL,
      commandId: command("agentneed"),
      projectId: scenario.projectId as ProjectId,
      expectedProjectRevision: 1,
      payload: {
        statement: "Agent观察到需要增加浏览器Provider失败恢复。",
        origin: "agent_candidate",
        occurredAt: NOW,
      },
    });
    expect(captured.need).toMatchObject({ status: "captured", origin: "agent_candidate" });
    expect(captured.need.commitmentDecisionId).toBeUndefined();
  });
});

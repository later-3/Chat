import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  projectAgentContextDtoSchema,
  projectHomeDtoSchema,
  projectMaintenancePlanDtoSchema,
  type PrincipalId,
  type ProductSnapshot,
} from "@chat/contracts";
import type {
  ApplicationDeps,
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
} from "@chat/application";
import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
} from "@chat/domain";
import { createApiApp } from "./app.js";

const PRINCIPAL = "usr_projectroutes" as PrincipalId;
const NOW = "2026-08-25T12:00:00.000Z";
const PROJECT_ID = "prj_projectroutes1" as const;
const PARTICIPANT_ID = "ppt_projectroutes1" as const;
const RESOURCE_ID = "prs_projectroutes1" as const;

class RouteStore implements ProductStorePort {
  #snapshot: ProductSnapshot;
  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = snapshot;
  }
  async read() {
    return { snapshot: structuredClone(this.#snapshot) };
  }
  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
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

function applicationDeps(): ApplicationDeps {
  const snapshot = createEmptySnapshot(NOW);
  const policies = compileProjectMethodSnapshotPolicies("software-delivery.v1");
  const rationale = "API纵向Fixture使用旧聚合兼容壳。";
  snapshot.entities.projectMethodSnapshots.pms_projectroutes1 = {
    schemaVersion: "project-method-snapshot.v3",
    projectMethodSnapshotId: "pms_projectroutes1" as never,
    projectId: PROJECT_ID as never,
    profileId: "software-delivery.v1",
    rationale,
    policies,
    source: "migrated_v1",
    sha256: computeProjectMethodSnapshotSha256({
      profileId: "software-delivery.v1",
      rationale,
      policies,
      source: "migrated_v1",
    }) as never,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projectStages.pst_projectroutes1 = {
    schemaVersion: "project-stage.v2",
    projectStageId: "pst_projectroutes1" as never,
    projectId: PROJECT_ID as never,
    methodSnapshotId: "pms_projectroutes1" as never,
    key: "foundation",
    name: "基础能力",
    goal: "建立全项目生命周期能力",
    successCriteria: ["用户View与Agent Context来自同一事实"],
    status: "active",
    sequence: 1,
    startedAt: NOW,
    completionEvidenceIds: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projects[PROJECT_ID] = {
    schemaVersion: "project.v2",
    projectId: PROJECT_ID as never,
    ownerPrincipalId: PRINCIPAL,
    name: "Chat",
    summary: "Chat自管理纵向",
    goal: "以对话推进不同类型项目",
    scopeIn: ["项目管理内核"],
    scopeOut: ["固定某个展示工具"],
    successCriteria: ["同一事实支撑用户和Agent"],
    status: "active",
    methodSnapshotId: "pms_projectroutes1" as never,
    currentStageId: "pst_projectroutes1" as never,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projectParticipants[PARTICIPANT_ID] = {
    schemaVersion: "project-participant.v1",
    projectParticipantId: PARTICIPANT_ID as never,
    projectId: PROJECT_ID as never,
    kind: "human",
    principalId: PRINCIPAL,
    displayName: "项目所有者",
    role: "owner",
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.projectResources[RESOURCE_ID] = {
    schemaVersion: "project-resource.v1",
    projectResourceId: RESOURCE_ID as never,
    projectId: PROJECT_ID as never,
    rootId: "root_chat",
    displayName: "Chat Git Workspace",
    kind: "workspace",
    enabledAdapters: ["local-git-workspace.v1"],
    status: "active",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    store: new RouteStore(snapshot),
    now: () => NOW,
    ids: new Proxy({}, { get: () => () => "unused" }) as ApplicationDeps["ids"],
  };
}

async function post(app: ReturnType<typeof createApiApp>, path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Project Management公开API纵向", () => {
  it("候选→采用→Need→Requirement后可读取Home、Context与Maintenance", async () => {
    const app = createApiApp({
      traceSink: null,
      product: { deps: applicationDeps(), principalId: PRINCIPAL },
    });
    const proposedResponse = await post(app, `/projects/${PROJECT_ID}/configuration-candidates`, {
      commandId: "cmd_routeconfig1",
      expectedRevision: 1,
      payload: {
        profileKey: "software-delivery",
        objective: "Chat持续管理自身以及其他类型Project。",
        scopeIn: ["对象、时间、历史、视图和Agent Context"],
        scopeOut: ["固定某个Viewer"],
        successCriteria: ["用户View和Agent Context由同一事实编译"],
        timezone: "Asia/Shanghai",
        schedulePolicy: {
          mode: "delivery",
          plannedActualComparison: true,
          recurrenceEnabled: false,
          cadences: [],
        },
        participantIds: [PARTICIPANT_ID],
        resourceBindings: [
          {
            projectResourceId: RESOURCE_ID,
            role: "source",
            required: true,
            capabilities: ["read", "version", "diff", "search"],
          },
        ],
        presentationBindings: [
          {
            capability: "document",
            providerKind: "embedded-document-view.v1",
            bindingRef: "chat:documents",
            mode: "primary",
          },
        ],
        terminology: {},
        requiredReads: ["AGENTS.md", "PROJECT_STATE.md"],
      },
    });
    expect(proposedResponse.status).toBe(201);
    const proposed = (await proposedResponse.json()) as {
      configuration: { projectConfigurationRevisionId: string; revision: number; sha256: string };
    };

    const adoptedResponse = await post(app, `/projects/${PROJECT_ID}/configuration-adoptions`, {
      commandId: "cmd_routeadopt1",
      expectedRevision: 1,
      payload: {
        candidateConfigurationRevisionId: proposed.configuration.projectConfigurationRevisionId,
        candidateRevision: proposed.configuration.revision,
        candidateSha256: proposed.configuration.sha256,
        decidedByParticipantId: PARTICIPANT_ID,
        rationale: "用户确认采用软件交付Profile。",
      },
    });
    expect(adoptedResponse.status).toBe(201);

    const needResponse = await post(app, `/projects/${PROJECT_ID}/needs`, {
      commandId: "cmd_routeneed1",
      expectedRevision: 1,
      payload: {
        statement: "用户需要在DSH或其他前端查看文档，而不是固定Obsidian。",
        origin: "user",
        occurredAt: NOW,
      },
    });
    expect(needResponse.status).toBe(201);
    const need = (await needResponse.json()) as { need: { projectNeedId: string } };

    const requirementResponse = await post(app, `/projects/${PROJECT_ID}/requirements`, {
      commandId: "cmd_routereq1",
      expectedRevision: 1,
      payload: {
        needIds: [need.need.projectNeedId],
        kind: "constraint",
        statement: "Profile只声明document capability，Provider由Configuration选择。",
        acceptanceCriteria: ["更换Viewer不改变Project、Artifact或历史身份"],
      },
    });
    expect(requirementResponse.status).toBe(201);

    const homeResponse = await app.request(`/api/projects/${PROJECT_ID}/home`);
    expect(homeResponse.status).toBe(200);
    const homeBody = (await homeResponse.json()) as { projectHome: unknown };
    const home = projectHomeDtoSchema.parse(homeBody.projectHome);
    expect(home.profile.profileKey).toBe("software-delivery");
    expect(home.objectCounts.need).toBe(1);
    expect(home.presentationSurfaces.find((item) => item.capability === "document")).toMatchObject({
      availability: "bound",
      binding: { providerKind: "embedded-document-view.v1" },
    });

    const queryResponse = await app.request(
      `/api/projects/${PROJECT_ID}/objects?q=Provider&kind=requirement&limit=20`,
    );
    expect(queryResponse.status).toBe(200);
    const queryBody = (await queryResponse.json()) as {
      result: { total: number; items: Array<{ kind: string; objectId: string }> };
    };
    expect(queryBody.result.total).toBe(1);
    expect(queryBody.result.items[0]).toMatchObject({ kind: "requirement" });

    const reviewResponse = await app.request(
      `/api/projects/${PROJECT_ID}/objects?view=review&limit=20`,
    );
    expect(reviewResponse.status).toBe(200);
    const reviewBody = (await reviewResponse.json()) as {
      result: { total: number; items: Array<{ kind: string; status?: string }> };
    };
    expect(reviewBody.result.items).toContainEqual(
      expect.objectContaining({ kind: "requirement", status: "proposed" }),
    );

    const contextResponse = await app.request(
      `/api/projects/${PROJECT_ID}/contexts/project_opening`,
    );
    expect(contextResponse.status).toBe(200);
    const contextBody = (await contextResponse.json()) as { context: unknown };
    const context = projectAgentContextDtoSchema.parse(contextBody.context);
    expect(context.requiredReads).toEqual(["AGENTS.md", "PROJECT_STATE.md"]);
    expect(context.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const maintenanceResponse = await app.request(
      `/api/projects/${PROJECT_ID}/maintenance?trigger=agent_started`,
    );
    expect(maintenanceResponse.status).toBe(200);
    const maintenanceBody = (await maintenanceResponse.json()) as { maintenance: unknown };
    const maintenance = projectMaintenancePlanDtoSchema.parse(maintenanceBody.maintenance);
    expect(maintenance.items.map((item) => item.action)).toContain("observe");
  });
});

import { describe, expect, it } from "vitest";
import { createEmptySnapshot, type PrincipalId, type ProductSnapshot } from "@chat/contracts";
import type {
  ApplicationDeps,
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
  ProjectIdFactory,
} from "./index.js";
import { createManagedProject } from "./managed-project-creation-use-cases.js";
import { CommandIdReusedError } from "./errors.js";

const NOW = "2026-08-25T12:00:00.000Z";
const PRINCIPAL = "usr_managedproject" as PrincipalId;

class Store implements ProductStorePort {
  #snapshot = createEmptySnapshot(NOW);

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

  inspect(): ProductSnapshot {
    return structuredClone(this.#snapshot);
  }
}

function projectIds(): ProjectIdFactory {
  return {
    project: () => "prj_managedproject1" as never,
    methodSnapshot: () => "pms_managedproject1" as never,
    stage: () => "pst_managedproject1" as never,
    resource: () => "prs_managedproject1" as never,
    participant: () => "ppt_managedproject1" as never,
    work: () => "pwk_managedproject1" as never,
    action: () => "pac_managedproject1" as never,
    contribution: () => "pct_managedproject1" as never,
    evidence: () => "pev_managedproject1" as never,
    decision: () => "pdc_managedproject1" as never,
    observation: () => "pob_managedproject1" as never,
    candidate: () => "pca_managedproject1" as never,
    milestone: () => "pml_managedproject1" as never,
    update: () => "pup_managedproject1" as never,
    stateTransition: () => "ptr_managedproject1" as never,
  };
}

function deps(store: Store): ApplicationDeps {
  return {
    store,
    now: () => NOW,
    ids: new Proxy({}, { get: () => () => "unused" }) as ApplicationDeps["ids"],
    projectIds: projectIds(),
    projectRoots: {
      list: () => [
        {
          rootId: "root_learning",
          displayName: "AI 学习 Workspace",
          enabledAdapters: [
            "local-git-workspace.v1",
            "project-document-manifest.v1",
            "package-script-catalog.v1",
          ],
          gitEvidenceEnabled: false,
        },
      ],
      observe: async () => {
        throw new Error("not used");
      },
    },
  };
}

const input = {
  principalId: PRINCIPAL,
  commandId: "cmd_managedprojectcreate1" as never,
  payload: {
    rootId: "root_learning",
    profileKey: "learning" as const,
    name: "AI 学习",
    summary: "建立可验证的AI工程能力。",
    objective: "通过解释、练习、测评和作品持续建立AI工程能力。",
    scopeIn: ["能力地图", "练习", "作品"],
    scopeOut: ["按课程数量推断掌握"],
    successCriteria: ["关键能力具有Evidence"],
    initialStage: { name: "能力地图", goal: "完成基线评估和第一轮计划。" },
    timezone: "Asia/Shanghai",
    schedulePolicy: {
      mode: "continuous" as const,
      plannedActualComparison: true,
      recurrenceEnabled: true,
      cadences: [
        {
          key: "weekly-learning-review",
          trigger: "weekly" as const,
          action: "review" as const,
          required: true,
        },
      ],
    },
    presentationBindings: [
      {
        capability: "project_home" as const,
        providerKind: "dsh-project-management.v1",
        bindingRef: "dsh:projects",
        mode: "primary" as const,
      },
    ],
    requiredReads: ["AGENTS.md", "PROJECT_CONTEXT.md"],
  },
};

describe("显式Managed Project创建", () => {
  it("一个命令原子建立learning实例、Workspace、Profile与首个采用Configuration", async () => {
    const store = new Store();
    const first = await createManagedProject(deps(store), input);
    const replay = await createManagedProject(deps(store), input);

    expect(replay.project.project.projectId).toBe(first.project.project.projectId);
    expect(store.inspect().storeRevision).toBe(1);
    expect(first.project.project).toMatchObject({
      name: "AI 学习",
      methodProfileId: "small-project.v1",
      participantCount: 1,
    });
    const snapshot = store.inspect();
    expect(Object.values(snapshot.entities.projectProfileRevisions)).toContainEqual(
      expect.objectContaining({ profileKey: "learning", title: "学习" }),
    );
    expect(Object.values(snapshot.entities.projectConfigurationRevisions)).toContainEqual(
      expect.objectContaining({
        projectId: first.project.project.projectId,
        status: "adopted",
        requiredReads: ["AGENTS.md", "PROJECT_CONTEXT.md"],
      }),
    );
    expect(Object.values(snapshot.entities.projectResources)).toContainEqual(
      expect.objectContaining({ rootId: "root_learning", displayName: "AI 学习 Workspace" }),
    );
  });
});

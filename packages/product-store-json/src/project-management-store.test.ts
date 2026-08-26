import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManagedProject, type ApplicationDeps } from "@chat/application";
import {
  computeProjectConfigurationRevisionSha256,
  compileBuiltInProjectProfileRevision,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV22Schema } from "./legacy-v22.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";
import type { ProductSnapshot, ProjectConfigurationRevision } from "@chat/contracts";

const NOW = "2026-08-25T12:00:00.000Z";

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "chat-project-management-v23-"));
  const filePath = join(directory, "product-store.json");
  const store = await JsonProductStore.open({ filePath, now: () => NOW });
  return { filePath, store };
}

function projectIds() {
  let sequence = 0;
  const allocate = (prefix: string) => () => `${prefix}_${String(++sequence)}store` as never;
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

async function managedSnapshot(input: { readonly secondProject?: boolean } = {}) {
  const { store } = await temporaryStore();
  const deps: ApplicationDeps = {
    store,
    now: () => NOW,
    ids: new Proxy({}, { get: () => () => "unused" }) as ApplicationDeps["ids"],
    projectIds: projectIds(),
    projectRoots: {
      list: () => [
        {
          rootId: "root_one",
          displayName: "One",
          enabledAdapters: ["local-git-workspace.v1"],
        },
        {
          rootId: "root_two",
          displayName: "Two",
          enabledAdapters: ["local-git-workspace.v1"],
        },
      ],
      observe: async () => {
        throw new Error("测试不观察Workspace");
      },
    },
  };
  const create = (rootId: "root_one" | "root_two", suffix: string) =>
    createManagedProject(deps, {
      principalId: "usr_storeintegrity" as never,
      commandId: `cmd_create${suffix}` as never,
      payload: {
        rootId,
        profileKey: "software-delivery",
        name: `Project ${suffix}`,
        summary: "验证项目管理Store完整性。",
        objective: "所有配置和事件历史都保持可解释。",
        scopeIn: ["完整性"],
        scopeOut: [],
        successCriteria: ["非法快照失败关闭"],
        initialStage: { name: "实现", goal: "完成完整性校验" },
        timezone: "Asia/Shanghai",
        schedulePolicy: {
          mode: "delivery",
          plannedActualComparison: true,
          recurrenceEnabled: false,
          cadences: [],
        },
        presentationBindings: [
          {
            capability: "project_home",
            providerKind: "dsh",
            bindingRef: `project:${suffix}`,
            mode: "primary",
          },
        ],
        requiredReads: ["AGENTS.md"],
      },
    });
  const first = await create("root_one", "one");
  const second = input.secondProject ? await create("root_two", "two") : undefined;
  return {
    snapshot: structuredClone(
      (await store.read({ kind: "committedSnapshot" })).snapshot,
    ) as ProductSnapshot,
    firstProjectId: first.project.project.projectId,
    secondProjectId: second?.project.project.projectId,
  };
}

function rehashConfiguration(configuration: ProjectConfigurationRevision): void {
  const hashInput = { ...configuration };
  for (const key of ["schemaVersion", "sha256", "revision", "createdAt", "updatedAt"] as const) {
    Reflect.deleteProperty(hashInput, key);
  }
  configuration.sha256 = computeProjectConfigurationRevisionSha256(hashInput) as never;
}

describe("Product Store v23全项目生命周期事实", () => {
  it("v22只补七组空集合且首次落盘后重启逐字节幂等", async () => {
    const { filePath, store } = await temporaryStore();
    const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const entities = structuredClone(current.entities) as unknown as Record<string, unknown>;
    for (const key of [
      "projectProfileRevisions",
      "projectConfigurationRevisions",
      "projectEvents",
      "projectNeeds",
      "projectRequirements",
      "projectArtifactRefs",
      "projectMetricObservations",
    ]) {
      delete entities[key];
    }
    const legacy = productSnapshotV22Schema.parse({
      ...current,
      schemaVersion: "chat-product-store.v22",
      entities,
    });
    await writeFile(filePath, JSON.stringify(legacy), "utf8");

    const migratedStore = await JsonProductStore.open({ filePath, now: () => NOW });
    const migrated = (await migratedStore.read({ kind: "committedSnapshot" })).snapshot;
    expect(migrated.schemaVersion).toBe("chat-product-store.v23");
    expect(migrated.storeRevision).toBe(legacy.storeRevision);
    expect(migrated.entities.projectProfileRevisions).toEqual({});
    expect(migrated.entities.projectConfigurationRevisions).toEqual({});
    expect(migrated.entities.projectEvents).toEqual({});
    expect(migrated.entities.projectNeeds).toEqual({});
    expect(migrated.entities.projectRequirements).toEqual({});
    expect(migrated.entities.projectArtifactRefs).toEqual({});
    expect(migrated.entities.projectMetricObservations).toEqual({});

    const once = await readFile(filePath, "utf8");
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("非空Profile Revision真实提交并在重启后完整恢复", async () => {
    const { filePath, store } = await temporaryStore();
    const profile = compileBuiltInProjectProfileRevision({
      profileKey: "software-delivery",
      now: NOW,
    });
    await store.transact({
      commandId: "cmd_profileappend1" as never,
      commandType: "RegisterProjectProfileRevision",
      requestSha256: "a".repeat(64),
      mutate: (draft) => {
        draft.entities.projectProfileRevisions[profile.projectProfileRevisionId] = profile as never;
        return { resultRefs: { projectProfileRevisionId: profile.projectProfileRevisionId } };
      },
    });

    const reopened = await JsonProductStore.open({ filePath, now: () => NOW });
    const persisted = (await reopened.read({ kind: "committedSnapshot" })).snapshot.entities
      .projectProfileRevisions[profile.projectProfileRevisionId];
    expect(persisted).toEqual(profile);
  });

  it("Configuration拒绝重复集合、伪造Supersedes和多后继", async () => {
    const { snapshot, firstProjectId } = await managedSnapshot();
    const current = Object.values(snapshot.entities.projectConfigurationRevisions).find(
      (configuration) => configuration.projectId === firstProjectId,
    )!;
    const corruptions: Array<(copy: ProductSnapshot) => void> = [
      (copy) => {
        const target =
          copy.entities.projectConfigurationRevisions[current.projectConfigurationRevisionId]!;
        target.participantIds = [target.participantIds[0]!, target.participantIds[0]!] as never;
        rehashConfiguration(target);
      },
      (copy) => {
        const target =
          copy.entities.projectConfigurationRevisions[current.projectConfigurationRevisionId]!;
        target.resourceBindings = [
          target.resourceBindings[0]!,
          target.resourceBindings[0]!,
        ] as never;
        rehashConfiguration(target);
      },
      (copy) => {
        const target =
          copy.entities.projectConfigurationRevisions[current.projectConfigurationRevisionId]!;
        target.presentationBindings = [
          target.presentationBindings[0]!,
          target.presentationBindings[0]!,
        ] as never;
        rehashConfiguration(target);
      },
      (copy) => {
        const target =
          copy.entities.projectConfigurationRevisions[current.projectConfigurationRevisionId]!;
        target.requiredReads = ["AGENTS.md", "AGENTS.md"];
        rehashConfiguration(target);
      },
      (copy) => {
        const candidate = structuredClone(current) as ProjectConfigurationRevision;
        candidate.projectConfigurationRevisionId = "pcf_invalidcandidate" as never;
        candidate.version = 2;
        candidate.status = "candidate";
        candidate.supersedesConfigurationRevisionId = current.projectConfigurationRevisionId;
        delete candidate.adoptedByDecisionId;
        delete candidate.effectiveFrom;
        rehashConfiguration(candidate);
        copy.entities.projectConfigurationRevisions[candidate.projectConfigurationRevisionId] =
          candidate;
      },
      (copy) => {
        for (const [index, id] of ["pcf_successorone", "pcf_successortwo"].entries()) {
          const successor = structuredClone(current) as ProjectConfigurationRevision;
          successor.projectConfigurationRevisionId = id as never;
          successor.version = index + 2;
          successor.supersedesConfigurationRevisionId = current.projectConfigurationRevisionId;
          rehashConfiguration(successor);
          copy.entities.projectConfigurationRevisions[successor.projectConfigurationRevisionId] =
            successor;
        }
      },
    ];
    for (const corrupt of corruptions) {
      const copy = structuredClone(snapshot);
      corrupt(copy);
      expect(() => assertSnapshotIntegrity(copy)).toThrow();
    }
  });

  it("Project Event拒绝伪ID、跨Project与断链，同时接受历史Revision到当前对象的连续演进", async () => {
    const { snapshot, firstProjectId, secondProjectId } = await managedSnapshot({
      secondProject: true,
    });
    if (secondProjectId === undefined) throw new Error("第二Project缺失");
    const created = Object.values(snapshot.entities.projectEvents).find(
      (event) => event.projectId === firstProjectId && event.eventType === "project.created",
    )!;
    const fake = structuredClone(snapshot);
    fake.entities.projectEvents[created.projectEventId]!.subject.objectId = "prj_missing";
    expect(() => assertSnapshotIntegrity(fake)).toThrow(/Subject不存在/u);

    const crossed = structuredClone(snapshot);
    crossed.entities.projectEvents[created.projectEventId]!.subject.objectId = secondProjectId;
    expect(() => assertSnapshotIntegrity(crossed)).toThrow(/跨Project/u);

    const evolved = structuredClone(snapshot);
    const project = evolved.entities.projects[firstProjectId]!;
    project.revision = 2;
    project.updatedAt = "2026-08-25T12:01:00.000Z";
    evolved.entities.projectEvents.pev_projectevolved = {
      ...created,
      projectEventId: "pev_projectevolved" as never,
      eventType: "project.updated",
      subject: { kind: "project", objectId: firstProjectId },
      occurredAt: project.updatedAt,
      observedAt: project.updatedAt,
      recordedAt: project.updatedAt,
      beforeRevision: 1,
      afterRevision: 2,
      payloadSha256: hashCanonical("project-event-test.v1", { revision: 2 }) as never,
      createdAt: project.updatedAt,
      updatedAt: project.updatedAt,
    };
    expect(() => assertSnapshotIntegrity(evolved)).not.toThrow();

    const broken = structuredClone(evolved);
    broken.entities.projects[firstProjectId]!.revision = 4;
    broken.entities.projectEvents.pev_projectevolved!.beforeRevision = 3;
    broken.entities.projectEvents.pev_projectevolved!.afterRevision = 4;
    expect(() => assertSnapshotIntegrity(broken)).toThrow(/历史链/u);
  });
});

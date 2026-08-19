import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planContentSchema,
  productSnapshotSchema,
  type CommandId,
  type NoteCandidateId,
  type NoteDecisionId,
  type NoteId,
  type NoteRevisionId,
  type PlanContent,
  type PrincipalId,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  commitConfirmedNote,
  compilePlanningInput,
  createProductSession,
  publishNoteCandidate,
  publishPlanForReview,
  submitNoteDecision,
  submitPlanDecision,
  submitUserMessage,
  type ApplicationDeps,
  type IdFactory,
  type NoteIdFactory,
} from "@chat/application";
import {
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
} from "@chat/application/workflow-system-definitions";
import { hashCanonical } from "@chat/domain";
import {
  JsonProductStore,
  migrateProductSnapshotV1ToV2,
  migrateProductSnapshotV2ToV3,
  migrateProductSnapshotV3ToV4,
  migrateProductSnapshotV4ToV5,
  migrateProductSnapshotV5ToV6,
  migrateProductSnapshotV6ToV7,
  migrateProductSnapshotV7ToV8,
  migrateProductSnapshotV8ToV9,
  migrateProductSnapshotV9ToV10,
  migrateProductSnapshotV10ToV11,
  migrateProductSnapshotV11ToV12,
  migrateProductSnapshotV12ToV13,
  productSnapshotV1Schema,
  productSnapshotV10Schema,
  type ProductSnapshotV10,
  type ProductSnapshotV1,
} from "@chat/product-store-json";

const NOW = "2026-08-10T16:00:00.000Z";
const OWNER = "usr_s7fixture" as PrincipalId;
export const S7_LEGACY_FIXTURE_SOURCE_COMMIT = "7692155d9f4e7b75eeaa819c7955041e2748689a";

export type S7FixtureWorkload = "legacy_planning" | "new_planning" | "note_capture";
export type S7FixtureLifecycle = "active" | "waiting" | "terminal";
export type S7Compatibility = "resumable" | "current" | "read_only_history";
export type S7FixtureSchemaVersion =
  | "chat-product-store.v1"
  | "chat-product-store.v2"
  | "chat-product-store.v3"
  | "chat-product-store.v4"
  | "chat-product-store.v5"
  | "chat-product-store.v6"
  | "chat-product-store.v7"
  | "chat-product-store.v8"
  | "chat-product-store.v9"
  | "chat-product-store.v10";

type ProductSnapshotV2Fixture = ReturnType<typeof migrateProductSnapshotV1ToV2>;
type ProductSnapshotV3Fixture = ReturnType<typeof migrateProductSnapshotV2ToV3>;
type ProductSnapshotV4Fixture = ReturnType<typeof migrateProductSnapshotV3ToV4>;
type ProductSnapshotV5Fixture = ReturnType<typeof migrateProductSnapshotV4ToV5>;
type ProductSnapshotV6Fixture = ReturnType<typeof migrateProductSnapshotV5ToV6>;
type ProductSnapshotV7Fixture = ReturnType<typeof migrateProductSnapshotV6ToV7>;
type ProductSnapshotV8Fixture = ReturnType<typeof migrateProductSnapshotV7ToV8>;
type ProductSnapshotV9Fixture = ReturnType<typeof migrateProductSnapshotV8ToV9>;
type ProductSnapshotV11Fixture = ReturnType<typeof migrateProductSnapshotV10ToV11>;
type ProductSnapshotV12Fixture = ReturnType<typeof migrateProductSnapshotV11ToV12>;
export type S7VersionedFixtureSnapshot =
  | ProductSnapshotV1
  | ProductSnapshotV2Fixture
  | ProductSnapshotV3Fixture
  | ProductSnapshotV4Fixture
  | ProductSnapshotV5Fixture
  | ProductSnapshotV6Fixture
  | ProductSnapshotV7Fixture
  | ProductSnapshotV8Fixture
  | ProductSnapshotV9Fixture
  | ProductSnapshotV10
  | ProductSnapshotV11Fixture
  | ProductSnapshotV12Fixture
  | ProductSnapshot;

export interface S7VersionedFixtureManifestEntry {
  readonly fixtureId: string;
  /** null明确表示Fixture来自尚未提交的最终工作树合同，不能伪造Git provenance。 */
  readonly sourceCommit: string | null;
  readonly sourceKind: "historical_contract" | "working_tree_generated";
  readonly schemaVersion: S7FixtureSchemaVersion;
  readonly workload: S7FixtureWorkload;
  readonly lifecycle: S7FixtureLifecycle;
  readonly compatibility: S7Compatibility;
  readonly objectCount: number;
  readonly contentSha256: string;
}

/**
 * Manifest值由同文件的确定性、脱敏Fixture构造器生成后冻结；测试会重新计算并逐项比较。
 * 来源commit是Fixture首次落库所基于的合同commit，不随工作树HEAD自动漂移。
 */
export const S7_VERSIONED_FIXTURE_MANIFEST: readonly S7VersionedFixtureManifestEntry[] = [
  {
    fixtureId: "v1-legacy-planning-active",
    sourceCommit: S7_LEGACY_FIXTURE_SOURCE_COMMIT,
    sourceKind: "historical_contract",
    schemaVersion: "chat-product-store.v1",
    workload: "legacy_planning",
    lifecycle: "active",
    compatibility: "resumable",
    objectCount: 4,
    contentSha256: "d41605afc6934970c0b3b696351b1c3191fe62eccb6fa91e19cef4151eb51364",
  },
  {
    fixtureId: "v1-legacy-planning-waiting",
    sourceCommit: S7_LEGACY_FIXTURE_SOURCE_COMMIT,
    sourceKind: "historical_contract",
    schemaVersion: "chat-product-store.v1",
    workload: "legacy_planning",
    lifecycle: "waiting",
    compatibility: "resumable",
    objectCount: 7,
    contentSha256: "f71605a50552f481ffcc28de0ecf29b84f3cb6493f1f001490edf44226eb9071",
  },
  {
    fixtureId: "v1-legacy-planning-terminal",
    sourceCommit: S7_LEGACY_FIXTURE_SOURCE_COMMIT,
    sourceKind: "historical_contract",
    schemaVersion: "chat-product-store.v1",
    workload: "legacy_planning",
    lifecycle: "terminal",
    compatibility: "read_only_history",
    objectCount: 4,
    contentSha256: "e26ab8ae54ab24c74716b47cad807c0ccb610d2aee547674f9f95610191f70ba",
  },
  ...(
    [
      ["v2", 5, "58d877865e1480f85f6ef4c6febb5884e0496d7c391f10c62ea2b80b4cde312d"],
      ["v3", 5, "27c5302a2db73c6ef3bd613643462b546c3490be3d39bf16c475e3c0bb219fd6"],
      ["v4", 5, "1fcb9af6be688f8f1a7760fe4781af3f4502cafc7790fa063c9591f9ba8b81d9"],
      ["v5", 5, "c50d061a71566724ce7d61cd26eaddb4dd0d8334726a6f337e00415f3481f7ec"],
      ["v6", 20, "76b64f1625fa3d7c09d6067f77d8570f6dbbe68c0fbf9453b5be9c692587e42c"],
      ["v7", 23, "17995f6c252d0a080ddb258a7a322896e330d9170a0d68306f82058895c14ac4"],
      ["v8", 26, "cd46483c86edcd06908c04dd1eefd4d1e498e7802af1151d0b7e2f16573fad3d"],
      ["v9", 26, "3f2fcf05ed3927bc9ebf8d855e95241874f2493a88f44b01e040bf53984a1514"],
    ] as const
  ).map(([version, objectCount, contentSha256]) => ({
    fixtureId: `${version}-legacy-planning-active`,
    sourceCommit: null,
    sourceKind: "working_tree_generated" as const,
    schemaVersion: `chat-product-store.${version}` as S7FixtureSchemaVersion,
    workload: "legacy_planning" as const,
    lifecycle: "active" as const,
    compatibility: "resumable" as const,
    objectCount,
    contentSha256,
  })),
  {
    fixtureId: "v10-new-planning-active",
    sourceCommit: null,
    sourceKind: "working_tree_generated",
    schemaVersion: "chat-product-store.v10",
    workload: "new_planning",
    lifecycle: "active",
    compatibility: "current",
    objectCount: 33,
    contentSha256: "145ef0348dec97042fbba593f20aa0e083ae5e0135044f440900185a02366443",
  },
  {
    fixtureId: "v10-new-planning-waiting",
    sourceCommit: null,
    sourceKind: "working_tree_generated",
    schemaVersion: "chat-product-store.v10",
    workload: "new_planning",
    lifecycle: "waiting",
    compatibility: "resumable",
    objectCount: 45,
    contentSha256: "4abaa4b1eb0174376a43c3944d0a88506f30c58e48cf1d6879f1b37e3bc9d651",
  },
  {
    fixtureId: "v10-new-planning-terminal",
    sourceCommit: null,
    sourceKind: "working_tree_generated",
    schemaVersion: "chat-product-store.v10",
    workload: "new_planning",
    lifecycle: "terminal",
    compatibility: "read_only_history",
    objectCount: 51,
    contentSha256: "290aece7a7d3d7e80e3e23c2130067e4818850a3a91a82b0c66c60a468902064",
  },
  {
    fixtureId: "v10-note-capture-active",
    sourceCommit: null,
    sourceKind: "working_tree_generated",
    schemaVersion: "chat-product-store.v10",
    workload: "note_capture",
    lifecycle: "active",
    compatibility: "current",
    objectCount: 15,
    contentSha256: "86f74b404d03e5e97d21e0e2dddf06ef567779a138b8cfe4f03c4c78e677c9c1",
  },
  {
    fixtureId: "v10-note-capture-waiting",
    sourceCommit: null,
    sourceKind: "working_tree_generated",
    schemaVersion: "chat-product-store.v10",
    workload: "note_capture",
    lifecycle: "waiting",
    compatibility: "resumable",
    objectCount: 22,
    contentSha256: "a48fc18afb45a5f022650ce73103371e38dac1b423527873c385301e7dded6c5",
  },
  {
    fixtureId: "v10-note-capture-terminal",
    sourceCommit: null,
    sourceKind: "working_tree_generated",
    schemaVersion: "chat-product-store.v10",
    workload: "note_capture",
    lifecycle: "terminal",
    compatibility: "read_only_history",
    objectCount: 38,
    contentSha256: "c8d30c2f5150563a48902f34b032d8abb2db258d1d0b1b3fc0b57db9924d14dc",
  },
];

export async function buildS7VersionedFixture(
  entry: Pick<S7VersionedFixtureManifestEntry, "schemaVersion" | "workload" | "lifecycle">,
): Promise<S7VersionedFixtureSnapshot> {
  if (entry.workload === "legacy_planning") {
    return legacyPlanningFixtureAtVersion(entry.lifecycle, entry.schemaVersion);
  }
  if (entry.schemaVersion !== "chat-product-store.v10") {
    throw new Error("new planning/note fixture只由当前v10合同生成");
  }
  return toV10Fixture(await currentFixture(entry.workload, entry.lifecycle));
}

export function migrateS7FixtureToCurrent(snapshot: S7VersionedFixtureSnapshot): ProductSnapshot {
  if (snapshot.schemaVersion === "chat-product-store.v13") return structuredClone(snapshot);
  const v2 =
    snapshot.schemaVersion === "chat-product-store.v1"
      ? migrateProductSnapshotV1ToV2(snapshot)
      : snapshot;
  const v3 = v2.schemaVersion === "chat-product-store.v2" ? migrateProductSnapshotV2ToV3(v2) : v2;
  const v4 = v3.schemaVersion === "chat-product-store.v3" ? migrateProductSnapshotV3ToV4(v3) : v3;
  const v5 = v4.schemaVersion === "chat-product-store.v4" ? migrateProductSnapshotV4ToV5(v4) : v4;
  const v6 = v5.schemaVersion === "chat-product-store.v5" ? migrateProductSnapshotV5ToV6(v5) : v5;
  const v7 = v6.schemaVersion === "chat-product-store.v6" ? migrateProductSnapshotV6ToV7(v6) : v6;
  const v8 = v7.schemaVersion === "chat-product-store.v7" ? migrateProductSnapshotV7ToV8(v7) : v7;
  const v9 = v8.schemaVersion === "chat-product-store.v8" ? migrateProductSnapshotV8ToV9(v8) : v8;
  const v10 = v9.schemaVersion === "chat-product-store.v9" ? migrateProductSnapshotV9ToV10(v9) : v9;
  const v11 =
    v10.schemaVersion === "chat-product-store.v10" ? migrateProductSnapshotV10ToV11(v10) : v10;
  const v12 =
    v11.schemaVersion === "chat-product-store.v11" ? migrateProductSnapshotV11ToV12(v11) : v11;
  const v13 =
    v12.schemaVersion === "chat-product-store.v12" ? migrateProductSnapshotV12ToV13(v12) : v12;
  return productSnapshotSchema.parse(v13);
}

function toV10Fixture(snapshot: ProductSnapshot): ProductSnapshotV10 {
  const downgraded = structuredClone(snapshot) as unknown as Record<string, unknown>;
  downgraded["schemaVersion"] = "chat-product-store.v10";
  const entities = downgraded["entities"] as Record<string, Record<string, unknown>>;
  delete entities["workflowDefinitions"]?.[SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID];
  delete entities["workflowDefinitionRevisions"]?.[SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID];
  delete entities["workflowViewDefinitions"]?.[SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID];
  delete entities["workflowDefinitions"]?.[SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID];
  delete entities["workflowDefinitionRevisions"]?.[SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID];
  delete entities["workflowViewDefinitions"]?.[SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID];
  delete entities["workflowDefinitions"]?.[SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID];
  delete entities["workflowDefinitionRevisions"]?.[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
  delete entities["workflowViewDefinitions"]?.[SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID];
  delete entities["workflowMemoryQueries"];
  delete entities["workflowMemorySnapshots"];
  delete entities["workflowMemoryContexts"];
  delete entities["memoryWriteIntents"];
  delete entities["memoryWriteResults"];
  delete entities["directAgentCandidates"];
  delete entities["promptReviewRequests"];
  delete entities["promptReviewDecisions"];
  return productSnapshotV10Schema.parse(downgraded);
}

export function fixtureObjectCount(snapshot: S7VersionedFixtureSnapshot): number {
  return (
    Object.values(snapshot.entities).reduce(
      (total, collection) => total + Object.keys(collection).length,
      0,
    ) +
    Object.keys(snapshot.commandReceipts).length +
    Object.keys(snapshot.outbox).length
  );
}

export function fixtureContentSha256(snapshot: S7VersionedFixtureSnapshot): string {
  return hashCanonical("s7-versioned-fixture.v1", snapshot);
}

function ids(namespace: string): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_${namespace}${(++sequence).toString(36)}`;
  return {
    session: () => next("psn") as ReturnType<IdFactory["session"]>,
    message: () => next("msg") as ReturnType<IdFactory["message"]>,
    run: () => next("run") as ReturnType<IdFactory["run"]>,
    attempt: () => next("att") as ReturnType<IdFactory["attempt"]>,
    plan: () => next("pln") as ReturnType<IdFactory["plan"]>,
    planRevision: () => next("plr") as ReturnType<IdFactory["planRevision"]>,
    revisionInput: () => next("rin") as ReturnType<IdFactory["revisionInput"]>,
    approval: () => next("apr") as ReturnType<IdFactory["approval"]>,
    decision: () => next("dec") as ReturnType<IdFactory["decision"]>,
    executionContract: () => next("exc") as ReturnType<IdFactory["executionContract"]>,
    executionCandidate: () => next("xcd") as ReturnType<IdFactory["executionCandidate"]>,
    validationResult: () => next("val") as ReturnType<IdFactory["validationResult"]>,
    artifact: () => next("art") as ReturnType<IdFactory["artifact"]>,
    outbox: () => next("obx") as ReturnType<IdFactory["outbox"]>,
  };
}

function noteIds(namespace: string): NoteIdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_${namespace}${(++sequence).toString(36)}`;
  return {
    note: () => next("nte") as NoteId,
    revision: () => next("ntr") as NoteRevisionId,
    candidate: () => next("ntc") as NoteCandidateId,
    decision: () => next("ntd") as NoteDecisionId,
  };
}

export async function createS7ApplicationFixture(namespace: string): Promise<{
  readonly deps: ApplicationDeps;
  command(): CommandId;
}> {
  const directory = await mkdtemp(join(tmpdir(), `chat-s7-${namespace}-`));
  let clock = 0;
  let commandSequence = 0;
  const now = () => new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  return {
    deps: { store, now, ids: ids(namespace), noteIds: noteIds(namespace) },
    command: () => `cmd_${namespace}${(++commandSequence).toString(36)}` as CommandId,
  };
}

const PLAN: PlanContent = planContentSchema.parse({
  objective: "验证S7兼容Fixture",
  summary: "冻结一份脱敏Planning候选",
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "核对兼容链",
      purpose: "证明历史事实保持",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "兼容结论",
      successCriteria: ["对象身份与Hash保持"],
      requestedCapabilities: [],
      risk: "low",
    },
  ],
  completionCriteria: ["兼容矩阵有明确结论"],
  warnings: [],
});

async function currentFixture(
  workload: Exclude<S7FixtureWorkload, "legacy_planning">,
  lifecycle: S7FixtureLifecycle,
): Promise<ProductSnapshot> {
  const namespace = `${workload === "new_planning" ? "s7pln" : "s7nte"}${lifecycle[0]}`;
  const fixture = await createS7ApplicationFixture(namespace);
  const { session } = await createProductSession(fixture.deps, {
    principalId: OWNER,
    commandId: fixture.command(),
    payload: {},
  });
  const seeded = await fixture.deps.store.read({ kind: "committedSnapshot" });
  const definitionRevisionId =
    workload === "note_capture"
      ? SYSTEM_NOTE_WORKFLOW_REVISION_ID
      : SYSTEM_PLANNING_WORKFLOW_REVISION_ID;
  const definitionSha256 =
    seeded.snapshot.entities.workflowDefinitionRevisions[definitionRevisionId]?.definitionSha256;
  if (definitionSha256 === undefined) throw new Error("S7 Fixture缺少系统Definition");
  const submitted = await submitUserMessage(fixture.deps, {
    principalId: OWNER,
    sessionId: session.sessionId,
    commandId: fixture.command(),
    payload: {
      text: workload === "new_planning" ? "生成脱敏兼容计划" : "沉淀脱敏兼容笔记",
      workflowSelection: {
        kind: "published_revision" as const,
        workflowDefinitionRevisionId: definitionRevisionId as never,
        definitionSha256,
        ...(workload === "note_capture"
          ? {
              businessInput: {
                kind: "note_capture" as const,
                source: { kind: "full_message" as const },
                defaultKind: "general" as const,
                suggestedTagLabels: [],
              },
            }
          : {}),
      },
    },
  });
  if (lifecycle === "active") {
    return (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  }
  if (workload === "new_planning") {
    const compiled = await compilePlanningInput(fixture.deps, {
      productRunId: submitted.run.productRunId,
      commandId: fixture.command(),
      planRevision: 1,
    });
    const published = await publishPlanForReview(fixture.deps, {
      productRunId: submitted.run.productRunId,
      commandId: fixture.command(),
      content: PLAN,
      attemptId: compiled.attemptId,
      expectedRunRevision: compiled.inputRunRevision,
      inputManifestSha256: compiled.inputManifestSha256,
    });
    if (lifecycle === "terminal") {
      await submitPlanDecision(fixture.deps, {
        principalId: OWNER,
        productRunId: submitted.run.productRunId,
        commandId: fixture.command(),
        expectedRunRevision: published.run.revision,
        payload: {
          approvalRequestId: published.approval.approvalRequestId,
          planId: published.plan.planId,
          planRevision: published.plan.planRevision,
          planSha256: published.plan.sha256,
          kind: "reject",
          reason: "S7终态兼容Fixture",
        },
      });
    }
  } else {
    const published = await publishNoteCandidate(fixture.deps, {
      productRunId: submitted.run.productRunId,
      commandId: fixture.command(),
      proposed: {
        title: "S7兼容笔记",
        kind: "general",
        contentMarkdown: "仅包含脱敏Fixture内容。",
        tagLabels: ["S7"],
      },
    });
    if (lifecycle === "terminal") {
      const waiting = (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
      const decided = await submitNoteDecision(fixture.deps, {
        principalId: OWNER,
        commandId: fixture.command(),
        expectedRunRevision:
          waiting.entities.runs[submitted.run.productRunId]?.revision ??
          (() => {
            throw new Error("S7 fixture缺少waiting Note Run");
          })(),
        payload: {
          productRunId: submitted.run.productRunId,
          noteCandidateId: published.candidate.noteCandidateId,
          candidateRevision: published.candidate.revision,
          candidateSha256: published.candidate.sha256,
          kind: "confirm",
        },
      });
      await commitConfirmedNote(fixture.deps, {
        productRunId: submitted.run.productRunId,
        noteCandidateId: decided.candidate.noteCandidateId,
        commandId: fixture.command(),
      });
    }
  }
  return (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
}

/** 每个物理版本都由同一份非空v1事实逐步升级，避免手工复制出互相漂移的伪Fixture。 */
function legacyPlanningFixtureAtVersion(
  lifecycle: S7FixtureLifecycle,
  schemaVersion: S7FixtureSchemaVersion,
): S7VersionedFixtureSnapshot {
  const v1 = legacyPlanningFixture(lifecycle);
  if (schemaVersion === "chat-product-store.v1") return v1;
  const v2 = migrateProductSnapshotV1ToV2(v1);
  if (schemaVersion === "chat-product-store.v2") return v2;
  const v3 = migrateProductSnapshotV2ToV3(v2);
  if (schemaVersion === "chat-product-store.v3") return v3;
  const v4 = migrateProductSnapshotV3ToV4(v3);
  if (schemaVersion === "chat-product-store.v4") return v4;
  const v5 = migrateProductSnapshotV4ToV5(v4);
  if (schemaVersion === "chat-product-store.v5") return v5;
  const v6 = migrateProductSnapshotV5ToV6(v5);
  if (schemaVersion === "chat-product-store.v6") return v6;
  const v7 = migrateProductSnapshotV6ToV7(v6);
  if (schemaVersion === "chat-product-store.v7") return v7;
  const v8 = migrateProductSnapshotV7ToV8(v7);
  if (schemaVersion === "chat-product-store.v8") return v8;
  const v9 = migrateProductSnapshotV8ToV9(v8);
  if (schemaVersion === "chat-product-store.v9") return v9;
  return migrateProductSnapshotV9ToV10(v9);
}

function legacyPlanningFixture(lifecycle: S7FixtureLifecycle): ProductSnapshotV1 {
  const sessionId = "psn_s7legacy1";
  const messageId = "msg_s7legacy1";
  const productRunId = "run_s7legacy1";
  const planningAttemptId = "att_s7legacy1";
  const planId = "pln_s7legacy1";
  const planRevisionId = "plr_s7legacy1";
  const approvalRequestId = "apr_s7legacy1";
  const workflowAttemptId = "att_s7workflow1";
  const sourceMessageSha256 = hashCanonical("message.v1", {
    messageId,
    sessionId,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "旧版脱敏Planning Fixture" },
  });
  const inputManifestSha256 = hashCanonical("planning-input-manifest.v1", {
    productRunId,
    planRevision: 1,
    sourceMessageRef: { messageId, sha256: sourceMessageSha256 },
    promptTemplateVersion: "legacy-planner.v1",
    modelConfigVersion: "legacy-model.v1",
  });
  const planSha256 = hashCanonical("plan-revision.v1", {
    planId,
    productRunId,
    planRevision: 1,
    content: PLAN,
  });
  const waiting = lifecycle === "waiting";
  return productSnapshotV1Schema.parse({
    schemaVersion: "chat-product-store.v1",
    storeRevision: 0,
    committedAt: NOW,
    entities: {
      sessions: {
        [sessionId]: {
          schemaVersion: "product-session.v1",
          sessionId,
          ownerPrincipalId: OWNER,
          status: "active",
          lastMessageSequence: 1,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      messages: {
        [messageId]: {
          schemaVersion: "message.v1",
          messageId,
          sessionId,
          sessionSequence: 1,
          role: "user",
          content: { format: "markdown", text: "旧版脱敏Planning Fixture" },
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      runs: {
        [productRunId]: {
          schemaVersion: "product-run.v1",
          productRunId,
          sessionId,
          sourceMessageId: messageId,
          status: waiting ? "waiting_human" : lifecycle === "terminal" ? "failed" : "running",
          phase: waiting ? "plan_review" : "planning",
          ...(waiting
            ? {
                currentPlanId: planId,
                currentPlanRevision: 1,
                currentApprovalRequestId: approvalRequestId,
              }
            : {}),
          ...(lifecycle === "terminal"
            ? { failure: { code: "fixture_terminal", summary: "历史Run明确失败" } }
            : {}),
          maxPlanRevisions: 3,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      attempts: {
        [workflowAttemptId]: {
          schemaVersion: "run-attempt.v1",
          attemptId: workflowAttemptId,
          productRunId,
          kind: "workflow",
          outcome: lifecycle === "terminal" ? "failure" : "running",
          ...(lifecycle === "terminal" ? { errorCode: "fixture_terminal" } : {}),
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
        ...(waiting
          ? {
              [planningAttemptId]: {
                schemaVersion: "run-attempt.v1",
                attemptId: planningAttemptId,
                productRunId,
                kind: "planning",
                planRevision: 1,
                inputRunRevision: 1,
                sourceMessageSha256,
                inputManifestSha256,
                promptTemplateVersion: "legacy-planner.v1",
                modelConfigVersion: "legacy-model.v1",
                outcome: "success",
                revision: 1,
                createdAt: NOW,
                updatedAt: NOW,
              },
            }
          : {}),
      },
      plans: waiting
        ? {
            [planRevisionId]: {
              schemaVersion: "plan-revision.v1",
              planRevisionId,
              planId,
              productRunId,
              planningAttemptId,
              planRevision: 1,
              status: "under_review",
              content: PLAN,
              sha256: planSha256,
              revision: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
          }
        : {},
      revisionInputs: {},
      approvalRequests: waiting
        ? {
            [approvalRequestId]: {
              schemaVersion: "approval-request.v1",
              approvalRequestId,
              productRunId,
              planId,
              planRevision: 1,
              planSha256,
              status: "open",
              expiresAt: "2026-08-11T16:00:00.000Z",
              revision: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
          }
        : {},
      decisions: {},
      executionContracts: {},
      executionCandidates: {},
      validationResults: {},
      artifacts: {},
    },
    commandReceipts: {},
    outbox: {},
  });
}

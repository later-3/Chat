import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  PRODUCT_API_SCHEMA_VERSION,
  loadWorkflowRunSpecResponseSchema,
  problemDetailSchema,
  sessionDtoSchema,
  workflowBlueprintsDtoSchema,
  workflowCatalogDtoSchema,
  workflowDefinitionsDtoSchema,
  workflowResourcesDtoSchema,
  workflowRunConfigSummaryDtoSchema,
  type CommandId,
  type PrincipalId,
  type ProductSessionId,
} from "@chat/contracts";
import { type ApplicationDeps, type IdFactory } from "@chat/application";
import {
  createSystemMemoryPlanningDefinition,
  createSystemPlanningDefinition,
  createSystemSimplePlanningDefinition,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
} from "@chat/application/workflow-system-definitions";
import {
  compileProjectMethodSnapshotPolicies,
  computeProjectMethodSnapshotSha256,
  hashCanonical,
} from "@chat/domain";
import { createApiApp, type ApiApp } from "@chat/api";
import { JsonProductStore } from "@chat/product-store-json";

const NOW = "2026-08-10T12:00:00.000Z";
const PRINCIPAL_A = "usr_qualitya" as PrincipalId;
const PRINCIPAL_B = "usr_qualityb" as PrincipalId;
const RUNTIME_KEY = "rtk_quality_gate";
const PRIVATE_DEFINITION_ID = "wfd_qualityprivate1";
const PRIVATE_REVISION_ID = "wfr_qualityprivate1";
const PRIVATE_PROJECT_ID = "prj_qualityprivate1";

function testIds(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_quality${(++sequence).toString(36)}`;
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

interface QualityFixture {
  readonly deps: ApplicationDeps;
  readonly appA: ApiApp;
  readonly appB: ApiApp;
  readonly systemDefinitionSha256: string;
  readonly memoryDefinitionSha256: string;
  readonly simpleDefinitionSha256: string;
  command(): CommandId;
}

async function qualityFixture(): Promise<QualityFixture> {
  const directory = await mkdtemp(join(tmpdir(), "chat-configurable-quality-"));
  let clock = 0;
  let commandSequence = 0;
  const now = () => new Date(Date.parse(NOW) + clock++ * 1_000).toISOString();
  const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
  const deps: ApplicationDeps = { store, now, ids: testIds() };
  const system = createSystemPlanningDefinition(NOW);
  const memorySystem = createSystemMemoryPlanningDefinition(NOW);
  const simpleSystem = createSystemSimplePlanningDefinition(NOW);
  const methodPolicies = compileProjectMethodSnapshotPolicies("small-project.v1");
  const methodSha256 = computeProjectMethodSnapshotSha256({
    profileId: "small-project.v1",
    rationale: "用于跨用户Workflow资源权限黑盒测试",
    policies: methodPolicies,
    source: "user_tailored",
  });

  // 该事务只播种另一个Principal拥有的正式Definition/Project；Receipt仍保持严格合法，
  // 测试随后只通过公开API验证“知道ID不等于有权限”。
  await store.transact({
    commandId: "cmd_qualityseed1" as CommandId,
    commandType: "CreateProductSession",
    requestSha256: hashCanonical("quality-gate-seed.v1", { owner: PRINCIPAL_B }),
    mutate: (draft) => {
      const sessionId = "psn_qualityseed1" as ProductSessionId;
      draft.entities.sessions[sessionId] = {
        schemaVersion: "product-session.v1",
        sessionId,
        ownerPrincipalId: PRINCIPAL_B,
        status: "active",
        lastMessageSequence: 0,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.workflowDefinitions[PRIVATE_DEFINITION_ID] = {
        ...system.definition,
        workflowDefinitionId: PRIVATE_DEFINITION_ID as never,
        ownerKind: "principal",
        ownerPrincipalId: PRINCIPAL_B,
        key: "quality.private-planning",
        title: "B的私有规划流程",
        publishedRevisionId: PRIVATE_REVISION_ID as never,
      };
      draft.entities.workflowDefinitionRevisions[PRIVATE_REVISION_ID] = {
        ...system.revision,
        workflowDefinitionRevisionId: PRIVATE_REVISION_ID as never,
        workflowDefinitionId: PRIVATE_DEFINITION_ID as never,
        title: "B的私有规划流程",
      };
      draft.entities.projectMethodSnapshots["pms_qualityprivate1"] = {
        schemaVersion: "project-method-snapshot.v2",
        projectMethodSnapshotId: "pms_qualityprivate1" as never,
        projectId: PRIVATE_PROJECT_ID as never,
        profileId: "small-project.v1",
        rationale: "用于跨用户Workflow资源权限黑盒测试",
        policies: methodPolicies,
        source: "user_tailored",
        sha256: methodSha256,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.projectStages["pst_qualityprivate1"] = {
        schemaVersion: "project-stage.v2",
        projectStageId: "pst_qualityprivate1" as never,
        projectId: PRIVATE_PROJECT_ID as never,
        methodSnapshotId: "pms_qualityprivate1" as never,
        key: "quality-gate",
        name: "B的私有阶段",
        goal: "证明Workflow资源按Principal隔离",
        successCriteria: ["A不能读取或选择B的Project"],
        status: "active",
        sequence: 1,
        startedAt: NOW,
        completionEvidenceIds: [],
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      draft.entities.projects[PRIVATE_PROJECT_ID] = {
        schemaVersion: "project.v2",
        projectId: PRIVATE_PROJECT_ID as never,
        ownerPrincipalId: PRINCIPAL_B,
        name: "B的私有项目",
        summary: "不可被A通过ID枚举或选择",
        goal: "验证Workflow Resource IDOR失败关闭",
        scopeIn: [],
        scopeOut: [],
        successCriteria: ["跨用户请求零写入"],
        status: "active",
        methodSnapshotId: "pms_qualityprivate1" as never,
        currentStageId: "pst_qualityprivate1" as never,
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return { resultRefs: { sessionId } };
    },
  });

  const makeApp = (principalId: PrincipalId) =>
    createApiApp({
      traceSink: null,
      product: { deps, principalId },
      internalRuntime: { credential: RUNTIME_KEY },
    });
  return {
    deps,
    appA: makeApp(PRINCIPAL_A),
    appB: makeApp(PRINCIPAL_B),
    systemDefinitionSha256: system.revision.definitionSha256,
    memoryDefinitionSha256: memorySystem.revision.definitionSha256,
    simpleDefinitionSha256: simpleSystem.revision.definitionSha256,
    command: () => `cmd_quality${(++commandSequence).toString(36)}` as CommandId,
  };
}

async function postJson(app: ApiApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postInternal(
  app: ApiApp,
  path: string,
  body: unknown,
  credential = RUNTIME_KEY,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat-runtime-key": credential },
    body: JSON.stringify(body),
  });
}

async function createSession(fixture: QualityFixture, app = fixture.appA) {
  const response = await postJson(app, "/api/sessions", {
    commandId: fixture.command(),
    payload: {},
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return sessionDtoSchema.parse(((await response.json()) as { session: unknown }).session);
}

function explicitSystemSelection(fixture: QualityFixture) {
  return {
    kind: "published_revision" as const,
    workflowDefinitionRevisionId: SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    definitionSha256: fixture.systemDefinitionSha256,
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1" as const,
      overrides: [],
    },
  };
}

function explicitMemorySelection(fixture: QualityFixture) {
  return {
    kind: "published_revision" as const,
    workflowDefinitionRevisionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
    definitionSha256: fixture.memoryDefinitionSha256,
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1" as const,
      overrides: [],
    },
  };
}

function explicitDefaultSelection(fixture: QualityFixture) {
  return {
    kind: "published_revision" as const,
    workflowDefinitionRevisionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    definitionSha256: fixture.simpleDefinitionSha256,
    runConfiguration: {
      schemaVersion: "workflow-run-configuration.v1" as const,
      overrides: [],
    },
  };
}

async function submitMessage(
  fixture: QualityFixture,
  sessionId: string,
  commandId: CommandId,
  workflowSelection?: unknown,
  app = fixture.appA,
) {
  return postJson(app, `/api/sessions/${sessionId}/messages`, {
    commandId,
    payload: {
      text: "S4质量门：生成一份可审核计划",
      ...(workflowSelection === undefined ? {} : { workflowSelection }),
    },
  });
}

async function snapshotOf(fixture: QualityFixture) {
  return (await fixture.deps.store.read({ kind: "committedSnapshot" })).snapshot;
}

function expectExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual([...expected].sort());
}

describe("S4 configured message黑盒质量门", () => {
  it("旧客户端默认与显式同配置语义等价，command replay复用原RunSpec", async () => {
    const fixture = await qualityFixture();
    const firstSession = await createSession(fixture);
    const commandId = fixture.command();
    const defaultResponse = await submitMessage(fixture, firstSession.sessionId, commandId);
    expect(defaultResponse.status, await defaultResponse.clone().text()).toBe(201);
    const first = (await defaultResponse.json()) as {
      run: { productRunId: string; workflowRunSpecId?: string };
    };

    const replay = await submitMessage(
      fixture,
      firstSession.sessionId,
      commandId,
      explicitDefaultSelection(fixture),
    );
    expect(replay.status, await replay.clone().text()).toBe(201);
    const replayed = (await replay.json()) as {
      run: { productRunId: string; workflowRunSpecId?: string };
    };
    expect(replayed.run).toEqual(first.run);

    const secondSession = await createSession(fixture);
    const explicitResponse = await submitMessage(
      fixture,
      secondSession.sessionId,
      fixture.command(),
      explicitDefaultSelection(fixture),
    );
    expect(explicitResponse.status, await explicitResponse.clone().text()).toBe(201);
    const explicit = (await explicitResponse.json()) as {
      run: { productRunId: string; workflowRunSpecId?: string };
    };
    const snapshot = await snapshotOf(fixture);
    const defaultSpec = snapshot.entities.workflowRunSpecs[first.run.workflowRunSpecId ?? ""];
    const explicitSpec = snapshot.entities.workflowRunSpecs[explicit.run.workflowRunSpecId ?? ""];
    expect(defaultSpec?.sha256).toBe(explicitSpec?.sha256);
    expect(defaultSpec?.definitionRef).toEqual(explicitSpec?.definitionRef);
    expect(defaultSpec?.nodeResolutions).toEqual(explicitSpec?.nodeResolutions);
    expect(defaultSpec?.resourceResolutions).toEqual(explicitSpec?.resourceResolutions);

    const submittedReceipts = Object.values(snapshot.commandReceipts).filter(
      (receipt) => receipt.commandType === "SubmitUserMessage",
    );
    expect(submittedReceipts).toHaveLength(2);
    expect(Object.keys(snapshot.entities.workflowRunSpecs)).toHaveLength(2);
    expect(
      Object.values(snapshot.outbox).filter((entry) => entry.kind === "workflow_start"),
    ).toHaveLength(2);
  });

  it("stale hash、非法/重复override和未知字段全部零写入", async () => {
    const fixture = await qualityFixture();
    const session = await createSession(fixture);
    const invalidSelections: readonly unknown[] = [
      {
        ...explicitSystemSelection(fixture),
        workflowDefinitionRevisionId: "wfr_missingquality1",
      },
      {
        ...explicitSystemSelection(fixture),
        definitionSha256: "0".repeat(64),
      },
      {
        ...explicitSystemSelection(fixture),
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "node_enabled",
              definitionNodeId: "planning.missing",
              enabled: false,
            },
          ],
        },
      },
      {
        ...explicitSystemSelection(fixture),
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "resource_selection",
              definitionNodeId: "planning.project",
              resourceKind: "project",
              required: false,
              selections: [],
            },
            {
              kind: "resource_selection",
              definitionNodeId: "planning.project",
              resourceKind: "memory",
              required: false,
              selections: [],
            },
          ],
        },
      },
      {
        ...explicitSystemSelection(fixture),
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            { kind: "node_enabled", definitionNodeId: "planning.memory-query", enabled: false },
            { kind: "node_enabled", definitionNodeId: "planning.memory-query", enabled: true },
          ],
        },
      },
      {
        ...explicitSystemSelection(fixture),
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [{ kind: "node_enabled", definitionNodeId: "planning.plan", enabled: false }],
        },
      },
      {
        ...explicitSystemSelection(fixture),
        internalExecutorKey: "exec.secret",
      },
      {
        ...explicitSystemSelection(fixture),
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "review_mode",
              definitionNodeId: "planning.review",
              reviewMode: "never_review",
            },
          ],
        },
      },
    ];

    for (const workflowSelection of invalidSelections) {
      const before = structuredClone(await snapshotOf(fixture));
      const response = await submitMessage(
        fixture,
        session.sessionId,
        fixture.command(),
        workflowSelection,
      );
      expect([400, 409, 422], await response.clone().text()).toContain(response.status);
      expect(problemDetailSchema.parse(await response.json()).code).toMatch(
        /^(validation_failed|definition_stale|policy_denied)$/u,
      );
      expect(await snapshotOf(fixture)).toEqual(before);
    }
  });

  it("资源revision/hash过期返回resource_stale且零写入", async () => {
    const fixture = await qualityFixture();
    const snapshot = await snapshotOf(fixture);
    const project = snapshot.entities.projects[PRIVATE_PROJECT_ID];
    if (project === undefined) throw new Error("fixture缺少私有Project");
    const projectSha256 = hashCanonical("workflow-project-ref.v1", {
      projectId: project.projectId,
      revision: project.revision,
      updatedAt: project.updatedAt,
    });
    const staleSelections = [
      { expectedRevision: project.revision + 1, expectedSha256: projectSha256 },
      { expectedRevision: project.revision, expectedSha256: "0".repeat(64) },
    ] as const;
    for (const stale of staleSelections) {
      const before = structuredClone(await snapshotOf(fixture));
      const response = await submitMessage(
        fixture,
        "psn_qualityseed1",
        fixture.command(),
        {
          ...explicitSystemSelection(fixture),
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [
              {
                kind: "resource_selection",
                definitionNodeId: "planning.project",
                resourceKind: "project",
                required: true,
                selections: [
                  {
                    resourceId: project.projectId,
                    expectedRevision: stale.expectedRevision,
                    expectedSha256: stale.expectedSha256,
                  },
                ],
              },
            ],
          },
        },
        fixture.appB,
      );
      expect(response.status, await response.clone().text()).toBe(409);
      expect(problemDetailSchema.parse(await response.json()).code).toBe("resource_stale");
      expect(await snapshotOf(fixture)).toEqual(before);
    }
  });

  it("跨用户Definition和Project ID即使版本Hash已知也失败关闭且零写入", async () => {
    const fixture = await qualityFixture();
    const session = await createSession(fixture);
    const snapshot = await snapshotOf(fixture);
    const privateRevision = snapshot.entities.workflowDefinitionRevisions[PRIVATE_REVISION_ID];
    if (privateRevision === undefined) throw new Error("fixture缺少私有Definition Revision");
    const privateProject = snapshot.entities.projects[PRIVATE_PROJECT_ID];
    if (privateProject === undefined) throw new Error("fixture缺少私有Project");
    const privateProjectSha256 = hashCanonical("workflow-project-ref.v1", {
      projectId: privateProject.projectId,
      revision: privateProject.revision,
      updatedAt: privateProject.updatedAt,
    });
    const attempts = [
      {
        kind: "published_revision",
        workflowDefinitionRevisionId: privateRevision.workflowDefinitionRevisionId,
        definitionSha256: privateRevision.definitionSha256,
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [],
        },
      },
      {
        ...explicitSystemSelection(fixture),
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "resource_selection",
              definitionNodeId: "planning.project",
              resourceKind: "project",
              required: false,
              selections: [
                {
                  resourceId: privateProject.projectId,
                  expectedRevision: privateProject.revision,
                  expectedSha256: privateProjectSha256,
                },
              ],
            },
          ],
        },
      },
    ] as const;

    for (const selection of attempts) {
      const before = structuredClone(await snapshotOf(fixture));
      const response = await submitMessage(
        fixture,
        session.sessionId,
        fixture.command(),
        selection,
      );
      expect([403, 404], await response.clone().text()).toContain(response.status);
      expect(problemDetailSchema.parse(await response.json()).code).toMatch(
        /^(forbidden|not_found)$/u,
      );
      expect(await snapshotOf(fixture)).toEqual(before);
    }
  });
});

describe("S4公开Workflow Query黑盒质量门", () => {
  const responseParsers = {
    "/api/workflow/catalog": (value: unknown) => {
      expectExactKeys(value, ["catalog"]);
      const catalog = workflowCatalogDtoSchema.parse(value["catalog"]);
      const planReview = catalog.nodes.find((node) => node.nodeType === "human.plan_review");
      const reviewField = planReview?.publicConfigFields.find(
        (field) => field.type === "review_mode",
      );
      expect(reviewField?.type === "review_mode" ? reviewField.options : undefined).toEqual([
        "manual",
      ]);
    },
    "/api/workflow/blueprints": (value: unknown) => {
      expectExactKeys(value, ["blueprints"]);
      const blueprints = workflowBlueprintsDtoSchema.parse(value["blueprints"]);
      expect(
        blueprints.blueprints.find((blueprint) => blueprint.blueprintKey === "planning")
          ?.reviewModes,
      ).toEqual(["manual"]);
      expect(
        blueprints.blueprints.find((blueprint) => blueprint.blueprintKey === "note")?.reviewModes,
      ).toEqual(["manual", "auto_continue_if_policy_allows"]);
    },
    "/api/workflow/definitions": (value: unknown) => {
      expectExactKeys(value, ["definitions"]);
      workflowDefinitionsDtoSchema.parse(value["definitions"]);
    },
    "/api/workflow/resources": (value: unknown) => {
      expectExactKeys(value, ["resources"]);
      workflowResourcesDtoSchema.parse(value["resources"]);
    },
  } as const;

  it("catalog/blueprint/definition/resource均为strict DTO并支持ETag/304", async () => {
    const fixture = await qualityFixture();
    for (const [path, parse] of Object.entries(responseParsers)) {
      const response = await fixture.appA.request(path);
      expect(response.status, path).toBe(200);
      const etag = response.headers.get("etag");
      expect(etag, path).toMatch(/^"[a-f0-9]{64}"$/u);
      expect(response.headers.get("cache-control"), path).toBe("private, no-cache");
      expect(response.headers.get("vary"), path).toContain("Authorization");
      parse(await response.json());
      const notModified = await fixture.appA.request(path, {
        headers: { "if-none-match": etag ?? "" },
      });
      expect(notModified.status, path).toBe(304);
      expect(await notModified.text()).toBe("");
      const wildcard = await fixture.appA.request(path, {
        headers: { "if-none-match": `"unrelated", *` },
      });
      expect(wildcard.status, path).toBe(304);
    }
  });

  it("Definitions/Resources按Principal裁剪，未知与重复Query参数安全拒绝", async () => {
    const fixture = await qualityFixture();
    const definitionsA = workflowDefinitionsDtoSchema.parse(
      (
        (await (await fixture.appA.request("/api/workflow/definitions")).json()) as {
          definitions: unknown;
        }
      ).definitions,
    );
    const definitionsB = workflowDefinitionsDtoSchema.parse(
      (
        (await (await fixture.appB.request("/api/workflow/definitions")).json()) as {
          definitions: unknown;
        }
      ).definitions,
    );
    expect(
      definitionsA.definitions.some(
        (definition) => definition.workflowDefinitionId === PRIVATE_DEFINITION_ID,
      ),
    ).toBe(false);
    expect(
      definitionsB.definitions.some(
        (definition) => definition.workflowDefinitionId === PRIVATE_DEFINITION_ID,
      ),
    ).toBe(true);

    const resourcesA = workflowResourcesDtoSchema.parse(
      (
        (await (await fixture.appA.request("/api/workflow/resources")).json()) as {
          resources: unknown;
        }
      ).resources,
    );
    const resourcesB = workflowResourcesDtoSchema.parse(
      (
        (await (await fixture.appB.request("/api/workflow/resources")).json()) as {
          resources: unknown;
        }
      ).resources,
    );
    expect(
      resourcesA.resources.some((resource) => resource.resourceId === PRIVATE_PROJECT_ID),
    ).toBe(false);
    expect(
      resourcesB.resources.some((resource) => resource.resourceId === PRIVATE_PROJECT_ID),
    ).toBe(true);

    for (const path of [
      "/api/workflow/catalog?unknown=1",
      "/api/workflow/blueprints?unknown=1",
      "/api/workflow/definitions?unknown=1",
      "/api/workflow/resources?kind=project&kind=memory",
      "/api/workflow/resources?kind=runtime",
    ]) {
      const response = await fixture.appA.request(path);
      expect(response.status, path).toBe(400);
      expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
    }
  });

  it("config-summary为strict DTO、支持ETag/304且跨用户不可读", async () => {
    const fixture = await qualityFixture();
    const session = await createSession(fixture);
    const sent = await submitMessage(
      fixture,
      session.sessionId,
      fixture.command(),
      explicitSystemSelection(fixture),
    );
    expect(sent.status).toBe(201);
    const run = ((await sent.json()) as { run: { productRunId: string } }).run;
    const path = `/api/runs/${run.productRunId}/workflow-config-summary`;
    const response = await fixture.appA.request(path);
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/u);
    const body = await response.json();
    expectExactKeys(body, ["summary"]);
    const summary = { summary: workflowRunConfigSummaryDtoSchema.parse(body["summary"]) };
    expect(summary.summary).toMatchObject({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      productRunId: run.productRunId,
      runnerFamily: "configurable-planning.v1",
    });
    expect(
      summary.summary.resourceSummary.every((resource) => resource.resolution === "excluded"),
    ).toBe(true);

    const notModified = await fixture.appA.request(path, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(notModified.status).toBe(304);
    const forbidden = await fixture.appB.request(path);
    expect([403, 404]).toContain(forbidden.status);
    const invalidQuery = await fixture.appA.request(`${path}?include=runtime`);
    expect(invalidQuery.status).toBe(400);
  });
});

describe("S4私有Runtime身份、篡改与幂等质量门", () => {
  it("load RunSpec严格绑定Run/Spec，拒绝坏凭据、未知字段和错绑身份", async () => {
    const fixture = await qualityFixture();
    const firstSession = await createSession(fixture);
    const firstResponse = await submitMessage(fixture, firstSession.sessionId, fixture.command());
    const first = (await firstResponse.json()) as { run: { productRunId: string } };
    const secondSession = await createSession(fixture);
    const secondResponse = await submitMessage(fixture, secondSession.sessionId, fixture.command());
    const second = (await secondResponse.json()) as { run: { productRunId: string } };
    const snapshot = await snapshotOf(fixture);
    const firstRun = snapshot.entities.runs[first.run.productRunId];
    const secondRun = snapshot.entities.runs[second.run.productRunId];
    if (firstRun?.workflowRunSpecId === undefined || secondRun?.workflowRunSpecId === undefined) {
      throw new Error("fixture的configurable Run缺少RunSpec");
    }
    const path = "/internal/runtime/v1/load-workflow-run-spec";
    const body = {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      productRunId: first.run.productRunId,
      workflowRunSpecId: firstRun.workflowRunSpecId,
    };
    const loaded = await postInternal(fixture.appA, path, body);
    expect(loaded.status, await loaded.clone().text()).toBe(200);
    expect(loadWorkflowRunSpecResponseSchema.parse(await loaded.json())).toMatchObject(body);

    const unauthorized = await postInternal(fixture.appA, path, body, "rtk_wrong");
    expect([401, 403]).toContain(unauthorized.status);
    const unknownField = await postInternal(fixture.appA, path, { ...body, hookToken: "secret" });
    expect(unknownField.status).toBe(400);
    const crossed = await postInternal(fixture.appA, path, {
      ...body,
      workflowRunSpecId: secondRun.workflowRunSpecId,
    });
    expect([404, 409]).toContain(crossed.status);
  });

  it("transition派生Node身份、command replay幂等并拒绝伪造Node ID和RunSpec错绑", async () => {
    const fixture = await qualityFixture();
    const session = await createSession(fixture);
    const sent = await submitMessage(
      fixture,
      session.sessionId,
      fixture.command(),
      explicitMemorySelection(fixture),
    );
    const { run } = (await sent.json()) as { run: { productRunId: string } };
    const snapshot = await snapshotOf(fixture);
    const storedRun = snapshot.entities.runs[run.productRunId];
    if (storedRun?.workflowRunSpecId === undefined) {
      throw new Error("fixture的configurable Run缺少RunSpec");
    }
    const path = "/internal/runtime/v1/transition-configurable-planning-node";
    const commandId = fixture.command();
    const body = {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      commandId,
      productRunId: run.productRunId,
      workflowRunSpecId: storedRun.workflowRunSpecId,
      definitionNodeId: "memory-planning.query",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "running",
      publicSummary: "正在查询记忆",
    };
    const first = await postInternal(fixture.appA, path, body);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    expectExactKeys(firstBody, ["workflowNodeRunId", "revision"]);
    expect(firstBody["workflowNodeRunId"]).toMatch(/^wnr_/u);
    expect(firstBody["revision"]).toEqual(expect.any(Number));
    const replay = await postInternal(fixture.appA, path, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const conflict = await postInternal(fixture.appA, path, {
      ...body,
      toStatus: "succeeded",
      outcomeCode: "completed",
    });
    expect(conflict.status).toBe(409);
    expect(problemDetailSchema.parse(await conflict.json()).code).toBe("command_id_reused");

    const forgedNodeId = await postInternal(fixture.appA, path, {
      ...body,
      commandId: fixture.command(),
      workflowNodeRunId: "wnr_forgedidentity1",
    });
    expect(forgedNodeId.status).toBe(400);
    const crossed = await postInternal(fixture.appA, path, {
      ...body,
      commandId: fixture.command(),
      workflowRunSpecId: "wrs_notbound1",
    });
    expect([404, 409]).toContain(crossed.status);

    const tamperedTransitions = [
      {
        definitionNodeId: "planning.plan",
        executionPath: [],
        toStatus: "running",
        publicSummary: "缺少review loop路径",
      },
      {
        definitionNodeId: "planning.project",
        executionPath: [{ containerNodeId: "planning.review.loop", iteration: 1 }],
        toStatus: "running",
        publicSummary: "伪造到不属于该节点的loop路径",
      },
      {
        definitionNodeId: "planning.project",
        executionPath: [],
        toStatus: "skipped",
        outcomeCode: "forged_skip",
        publicSummary: "Runtime不能伪造非冻结skip outcome",
      },
      {
        definitionNodeId: "planning.project",
        executionPath: [],
        toStatus: "waiting_human",
        publicSummary: "非human节点不能伪造人工等待",
      },
    ] as const;
    for (const tampered of tamperedTransitions) {
      const response = await postInternal(fixture.appA, path, {
        ...body,
        ...tampered,
        commandId: fixture.command(),
      });
      expect([409, 422], await response.clone().text()).toContain(response.status);
      expect(problemDetailSchema.parse(await response.json()).code).toMatch(
        /^(revision_conflict|validation_failed)$/u,
      );
    }
  });

  it("outcome_unknown同命令重放收敛，异payload冲突且未知Run不产生事实", async () => {
    const fixture = await qualityFixture();
    const session = await createSession(fixture);
    const sent = await submitMessage(fixture, session.sessionId, fixture.command());
    const { run } = (await sent.json()) as { run: { productRunId: string } };
    const path = "/internal/runtime/v1/commit-run-outcome-unknown";
    const body = {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      commandId: fixture.command(),
      productRunId: run.productRunId,
      errorCode: "execution.outcome_unknown",
      summary: "外部执行结果无法确认，等待人工对账",
    };
    const first = await postInternal(fixture.appA, path, body);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "committed",
    });
    const replay = await postInternal(fixture.appA, path, body);
    expect(replay.status).toBe(200);
    const snapshot = await snapshotOf(fixture);
    expect(snapshot.entities.runs[run.productRunId]).toMatchObject({
      status: "outcome_unknown",
      failure: { code: "execution.outcome_unknown" },
    });
    expect(
      Object.values(snapshot.commandReceipts).filter(
        (receipt) => receipt.commandType === "CommitRunOutcomeUnknown",
      ),
    ).toHaveLength(1);

    const terminalTransition = await postInternal(
      fixture.appA,
      "/internal/runtime/v1/transition-configurable-planning-node",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        commandId: fixture.command(),
        productRunId: run.productRunId,
        workflowRunSpecId: snapshot.entities.runs[run.productRunId]?.workflowRunSpecId,
        definitionNodeId: "planning.project",
        executionPath: [],
        attemptNumber: 1,
        toStatus: "running",
        publicSummary: "终态Run不能创建新Node执行",
      },
    );
    expect([409, 422], await terminalTransition.clone().text()).toContain(
      terminalTransition.status,
    );

    const conflict = await postInternal(fixture.appA, path, {
      ...body,
      summary: "同一命令不得改变未知结果说明",
    });
    expect(conflict.status).toBe(409);
    const beforeMissing = structuredClone(await snapshotOf(fixture));
    const missing = await postInternal(fixture.appA, path, {
      ...body,
      commandId: fixture.command(),
      productRunId: "run_missingquality1",
    });
    expect(missing.status).toBe(404);
    expect(await snapshotOf(fixture)).toEqual(beforeMissing);
  });
});

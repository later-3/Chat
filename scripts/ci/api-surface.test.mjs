import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertApiSurfaceBaselineChain,
  assertApiSurfaceCompatible,
  assertPublicContractIdentityAllowedForTest,
  assertPublicContractNameAllowed,
  classifySchemaRolesForTest,
  diffApiSurface,
  generateApiSurface,
  observableRouteContractFromFixtureForTest,
  validateCompatibleChangeRecords,
  validateWaivers,
} from "./api-surface.mjs";

const root = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(
  readFileSync(resolve(root, "config/api-surface.baseline.json"), "utf8"),
);
const emptyWaivers = { schemaVersion: 2, waivers: [] };
const emptyChanges = { schemaVersion: 2, changes: [] };

function clone(value) {
  return structuredClone(value);
}

test("API Surface由真实组合根确定性生成并排除私有Runtime身份", () => {
  const first = generateApiSurface();
  const second = generateApiSurface();
  assert.deepEqual(first, second);
  assert.deepEqual(first, baseline);
  assert.ok(first.routes.length > 50);
  assert.ok(first.publicSchemas.length > 100);
  assert.ok(first.packageExports.length === 14);
  assert.ok(
    first.routes.every((route) =>
      route.responseSchemas.every((response) => /^[0-9a-f]{64}$/u.test(response.signatureSha256)),
    ),
  );
  assert.ok(
    first.routes.every(
      (route) =>
        Array.isArray(route.pathParameters) &&
        Array.isArray(route.query.parsers) &&
        Array.isArray(route.body.schemas) &&
        route.successfulResponses.length > 0 &&
        route.problemContract.codes.length > 0 &&
        route.problemContract.recoveryActions.length > 0,
    ),
  );
  for (const route of first.routes) {
    const querySchemas = new Set(route.query.schemas.map((schema) => schema.identity));
    assert.deepEqual(
      route.responseSchemas.filter((schema) => querySchemas.has(schema.identity)),
      [],
      `${route.method} ${route.path}不能把响应Schema登记为Query Schema`,
    );
  }
  const memoryWrite = first.routes.find(
    (route) => route.method === "POST" && route.path === "/api/memory-writes",
  );
  const localSchema = memoryWrite?.body.schemas.find(
    (schema) => schema.identity === "createMemoryWritePayloadSchema",
  );
  assert.ok(localSchema);
  assert.notEqual(
    localSchema.signatureSha256,
    createHash("sha256").update("unresolved-schema:createMemoryWritePayloadSchema").digest("hex"),
    "路由引用的非public Schema必须冻结真实Contracts源码，不能退回名称哈希",
  );
  assert.doesNotMatch(
    JSON.stringify(first),
    /(?:\/internal\/runtime|hookToken|workflowRunId|piRuntimeSessionId|apiKey|promptText)/u,
  );
  assert.deepEqual(diffApiSurface(baseline, first), []);
  assert.deepEqual(assertApiSurfaceCompatible(baseline, first, emptyWaivers), []);
});

test("删除路由、公开导出或Schema均失败关闭", () => {
  const current = clone(baseline);
  const removedRoute = current.routes.shift();
  const exportedPackage = current.packageExports.find((entry) => entry.exportPaths.length > 0);
  assert.ok(exportedPackage);
  const removedExport = exportedPackage.exportPaths.shift();
  const removedSymbol = current.publicSymbols.shift();
  const removedSchema = current.publicSchemas.shift();
  const issueIds = diffApiSurface(baseline, current).map((entry) => entry.issueId);
  assert.ok(issueIds.includes(`route_removed:${removedRoute.method} ${removedRoute.path}`));
  assert.ok(issueIds.includes(`package_export_removed:${exportedPackage.name}:${removedExport}`));
  assert.ok(issueIds.includes(`public_symbol_removed:${removedSymbol.name}`));
  assert.ok(issueIds.includes(`schema_removed:${removedSchema.name}`));
});

test("新增必填、枚举收窄、同schema literal语义变化和错误码变化均被识别", () => {
  const current = clone(baseline);
  const schema = current.publicSchemas.find((entry) => entry.enumValues.length > 1);
  assert.ok(schema);
  const removedEnum = schema.enumValues.shift();
  schema.requiredFields.push("newRequiredField");
  schema.signatureSha256 = "f".repeat(64);
  current.problems.codes.push("new_problem_code");
  const issueIds = diffApiSurface(baseline, current).map((entry) => entry.issueId);
  assert.ok(issueIds.includes(`enum_narrowed:${schema.name}:${removedEnum}`));
  assert.ok(issueIds.includes(`required_field_added:${schema.name}.newRequiredField`));
  assert.ok(issueIds.includes(`same_schema_literal_changed:${schema.name}`));
  assert.ok(issueIds.includes("problem_code_added:new_problem_code"));
  assert.throws(
    () => assertApiSurfaceCompatible(baseline, current, emptyWaivers),
    /compatible change record|未获用户明确批准/u,
  );
});

test("响应Schema、HTTP状态、请求Schema、Problem Code与公开export继续失败关闭", () => {
  const responseChanged = clone(baseline);
  const responseRoute = responseChanged.routes.find((route) => route.responseSchemas.length > 0);
  assert.ok(responseRoute);
  responseRoute.responseSchemas[0].signatureSha256 = "a".repeat(64);
  assert.ok(
    diffApiSurface(baseline, responseChanged).some(
      (entry) =>
        entry.issueId === `route_contract_changed:${responseRoute.method} ${responseRoute.path}`,
    ),
  );

  const statusChanged = clone(baseline);
  const statusRoute = statusChanged.routes.find((route) => route.successfulResponses.length > 0);
  assert.ok(statusRoute);
  statusRoute.successfulResponses[0].status = "299";
  assert.ok(
    diffApiSurface(baseline, statusChanged).some(
      (entry) =>
        entry.issueId === `route_contract_changed:${statusRoute.method} ${statusRoute.path}`,
    ),
  );

  const requestChanged = clone(baseline);
  const requestRoute = requestChanged.routes.find((route) => route.body.schemas.length > 0);
  assert.ok(requestRoute);
  requestRoute.body.schemas[0].signatureSha256 = "b".repeat(64);
  assert.ok(
    diffApiSurface(baseline, requestChanged).some(
      (entry) =>
        entry.issueId === `route_contract_changed:${requestRoute.method} ${requestRoute.path}`,
    ),
  );

  const problemChanged = clone(baseline);
  const removedProblem = problemChanged.problems.codes.shift();
  assert.ok(removedProblem);
  assert.ok(
    diffApiSurface(baseline, problemChanged).some(
      (entry) => entry.issueId === `problem_code_removed:${removedProblem}`,
    ),
  );

  const exportChanged = clone(baseline);
  const exported = exportChanged.packageExports.find((entry) => entry.exportPaths.length > 0);
  assert.ok(exported);
  const exportKey = exported.exportPaths[0];
  exported.exports[exportKey] = {
    import: "./src/replacement.ts",
    types: "./src/replacement.ts",
  };
  assert.ok(
    diffApiSurface(baseline, exportChanged).some(
      (entry) => entry.issueId === `package_export_changed:${exported.name}:${exportKey}`,
    ),
  );
});

test("同分支同时改生成结果和checked-in baseline仍由base baseline阻止绕过", () => {
  const changed = clone(baseline);
  const removed = changed.routes.shift();
  assert.throws(
    () => assertApiSurfaceBaselineChain(baseline, changed, changed, emptyWaivers, emptyChanges),
    new RegExp(`route_removed:${removed.method} ${removed.path}`, "u"),
  );
  assert.deepEqual(assertApiSurfaceBaselineChain(undefined, baseline, baseline, emptyWaivers), []);
});

test("breaking change豁免必须绑定精确before→after摘要并记录批准与五段迁移", () => {
  const changed = clone(baseline);
  changed.routes.shift();
  const [entry] = diffApiSurface(baseline, changed);
  assert.ok(entry);
  const exact = {
    issueKind: entry.kind,
    target: entry.target,
    baseDigest: entry.baseDigest,
    currentDigest: entry.currentDigest,
    diffSha256: entry.diffSha256,
    approvedBy: "user:later",
    approvalReference: "thread:explicit",
    detect: "route diff",
    why: "example",
    fix: "migrate",
    verify: "contract",
    rollback: "restore",
  };
  assert.throws(
    () =>
      validateWaivers({
        schemaVersion: 2,
        waivers: [
          {
            ...exact,
            approvedBy: "agent:codex",
          },
        ],
      }),
    /明确用户批准/u,
  );
  assert.throws(
    () =>
      validateWaivers({
        schemaVersion: 2,
        waivers: [
          {
            ...exact,
            rollback: "",
          },
        ],
      }),
    /rollback/u,
  );
  assert.deepEqual(
    assertApiSurfaceCompatible(baseline, changed, { schemaVersion: 2, waivers: [exact] }),
    [entry],
  );

  const changedAgain = clone(changed);
  changedAgain.routes.shift();
  assert.throws(
    () =>
      assertApiSurfaceCompatible(baseline, changedAgain, { schemaVersion: 2, waivers: [exact] }),
    /过期|未获用户/u,
  );
});

test("真实请求源与成功响应源分离，return表达式中的输入Schema不会冒充响应", () => {
  const roles = classifySchemaRolesForTest(`
    const handler = async (c) =>
      c.json(createMemoryImportPayloadSchema.parse(await parseJsonBody(c)), 201);
  `);
  assert.deepEqual(roles, { request: ["createMemoryImportPayloadSchema"], response: [] });

  const memoryImport = baseline.routes.find(
    (route) => route.method === "POST" && route.path === "/api/memory-imports",
  );
  assert.ok(memoryImport);
  assert.ok(
    memoryImport.body.schemas.some(
      (schema) => schema.identity === "createMemoryImportPayloadSchema",
    ),
  );
  assert.ok(
    memoryImport.responseSchemas.every(
      (schema) => schema.identity !== "createMemoryImportPayloadSchema",
    ),
  );
});

test("package export目标与条件变化进入diff", () => {
  const changed = clone(baseline);
  const exported = changed.packageExports.find((entry) => entry.exportPaths.length > 0);
  assert.ok(exported);
  const key = exported.exportPaths[0];
  exported.exports[key] = { import: "./src/replacement.ts", types: "./src/replacement.ts" };
  const ids = diffApiSurface(baseline, changed).map((entry) => entry.issueId);
  assert.ok(ids.includes(`package_export_changed:${exported.name}:${key}`));
});

test("package摘要只在公共符号纯新增时归为compatible expansion", () => {
  const expanded = clone(baseline);
  expanded.publicSymbols.push({
    name: "SyntheticCompatibleAddition",
    kind: "type",
    signatureSha256: "a".repeat(64),
  });
  const expandedPackage = expanded.packageExports.find((entry) => entry.name === "@chat/contracts");
  assert.ok(expandedPackage);
  const expandedRoot = expandedPackage.subpaths.find((entry) => entry.key === ".");
  assert.ok(expandedRoot);
  expandedRoot.exportedSymbols.push("SyntheticCompatibleAddition");
  expandedRoot.transitiveSignatureSha256 = "b".repeat(64);
  expandedPackage.publicEntrySignatureSha256 = expandedRoot.transitiveSignatureSha256;
  const expandedIds = diffApiSurface(baseline, expanded).map((entry) => entry.issueId);
  assert.ok(expandedIds.includes("package_entry_expanded:@chat/contracts"));
  assert.ok(expandedIds.includes("package_export_expanded:@chat/contracts:."));
  assert.ok(!expandedIds.includes("package_executable_or_entry_changed:@chat/contracts"));
  assert.ok(!expandedIds.includes("package_export_changed:@chat/contracts:."));

  const replaced = clone(expanded);
  const replacedSymbol = replaced.publicSymbols.find(
    (entry) => entry.name !== "SyntheticCompatibleAddition" && entry.kind !== "schema",
  );
  assert.ok(replacedSymbol);
  replacedSymbol.signatureSha256 = "c".repeat(64);
  const replacedIds = diffApiSurface(baseline, replaced).map((entry) => entry.issueId);
  assert.ok(replacedIds.includes("package_executable_or_entry_changed:@chat/contracts"));
  assert.ok(replacedIds.includes("package_export_changed:@chat/contracts:."));
});

test("POST与其他公共新增即使同步更新baseline也必须有一次性精确change record", () => {
  const changed = clone(baseline);
  changed.routes.push({
    ...clone(changed.routes[0]),
    method: "POST",
    path: "/api/example-compatible-addition",
    kind: "command",
  });
  const [addition] = diffApiSurface(baseline, changed).filter(
    (entry) => entry.kind === "route_added",
  );
  assert.ok(addition);
  assert.throws(
    () => assertApiSurfaceBaselineChain(baseline, changed, changed, emptyWaivers, emptyChanges),
    /compatible change record/u,
  );
  const record = {
    issueKind: addition.kind,
    target: addition.target,
    baseDigest: addition.baseDigest,
    currentDigest: addition.currentDigest,
    diffSha256: addition.diffSha256,
    purpose: "add public route",
    owner: "@chat/api",
    verification: "contract test",
    rollbackOrRemoval: "remove route and restore baseline",
  };
  validateCompatibleChangeRecords({ schemaVersion: 2, changes: [record] });
  assert.deepEqual(
    assertApiSurfaceCompatible(baseline, changed, emptyWaivers, {
      schemaVersion: 2,
      changes: [record],
    }),
    [addition],
  );
  const second = clone(changed);
  second.routes.push({ ...clone(second.routes[0]), path: "/api/second-expansion" });
  assert.throws(
    () =>
      assertApiSurfaceCompatible(baseline, second, emptyWaivers, {
        schemaVersion: 2,
        changes: [record],
      }),
    /compatible change record/u,
  );
});

test("禁止的Runtime身份在public入口硬失败，Problem/Recovery增删分别报告", () => {
  assert.throws(() => assertPublicContractNameAllowed("WorkflowRunId"), /禁止/u);
  const changed = clone(baseline);
  const removedProblem = changed.problems.codes.shift();
  const removedRecovery = changed.problems.recoveryActions.shift();
  changed.problems.codes.push("new_problem");
  changed.problems.recoveryActions.push("new_recovery");
  const ids = diffApiSurface(baseline, changed).map((entry) => entry.issueId);
  assert.ok(ids.includes(`problem_code_removed:${removedProblem}`));
  assert.ok(ids.includes("problem_code_added:new_problem"));
  assert.ok(ids.includes(`recovery_action_removed:${removedRecovery}`));
  assert.ok(ids.includes("recovery_action_added:new_recovery"));
});

test("内部Application Operation替换不改变外部响应合同", () => {
  const fixture = (operation) => `
    type PublicNote = { id: string; title: string };
    declare function getNote(): Promise<PublicNote>;
    declare function getNoteHistory(): Promise<PublicNote>;
    declare const c: { json(body: unknown, status: number): unknown };
    const handler = async () => c.json(await ${operation}(), 200);
  `;
  const note = observableRouteContractFromFixtureForTest(fixture("getNote"));
  const history = observableRouteContractFromFixtureForTest(fixture("getNoteHistory"));
  assert.deepEqual(note, history);

  const changed = clone(baseline);
  const replacement = clone(baseline);
  changed.routes[0].successfulResponses = note.successfulResponses;
  changed.routes[0].responseSchemas = note.responseSchemas;
  replacement.routes[0].successfulResponses = history.successfulResponses;
  replacement.routes[0].responseSchemas = history.responseSchemas;
  assert.deepEqual(diffApiSurface(changed, replacement), []);
});

test("退休内部调用图字段不参与route diff或waiver摘要", () => {
  const addRetiredFields = (manifest, operation, resultHash) => {
    const route = manifest.routes.find((entry) => entry.successfulResponses.length > 0);
    route.applicationOperations = [operation];
    route.applicationOperationContracts = [{ operation, signatureSha256: resultHash }];
    route.successfulResponses[0].applicationResultSignatureSha256 = resultHash;
    return route;
  };

  const retiredOnly = clone(baseline);
  addRetiredFields(retiredOnly, "getNote", "1".repeat(64));
  assert.deepEqual(diffApiSurface(baseline, retiredOnly), []);

  const changed = clone(baseline);
  const changedRoute = changed.routes.find((entry) => entry.successfulResponses.length > 0);
  changedRoute.successfulResponses[0].status = "299";
  const plainIssue = diffApiSurface(baseline, changed).find(
    (entry) => entry.kind === "route_contract_changed",
  );
  assert.ok(plainIssue);

  const retiredBaseline = clone(baseline);
  const retiredChanged = clone(changed);
  addRetiredFields(retiredBaseline, "getNote", "2".repeat(64));
  addRetiredFields(retiredChanged, "getNoteHistory", "3".repeat(64));
  const retiredIssue = diffApiSurface(retiredBaseline, retiredChanged).find(
    (entry) => entry.kind === "route_contract_changed",
  );
  assert.deepEqual(retiredIssue, plainIssue);
});

test("响应提取器v4到v5只迁移不可比Hash，状态与Schema仍严格比较", () => {
  const previous = clone(baseline);
  previous.generation.routeContractExtraction = "observable-request-response-dataflow.v4";
  const route = previous.routes.find(
    (entry) =>
      entry.successfulResponses.length > 0 &&
      entry.successfulResponses[0].explicitSchemas.length === 0,
  );
  assert.ok(route);
  route.successfulResponses[0].source = "c.json";
  route.successfulResponses[0].signatureSha256 = "1".repeat(64);
  route.responseSchemas[0].signatureSha256 = "1".repeat(64);
  assert.deepEqual(diffApiSurface(previous, baseline), []);

  const statusChanged = clone(baseline);
  statusChanged.routes.find(
    (entry) => entry.method === route.method && entry.path === route.path,
  ).successfulResponses[0].status = "299";
  assert.ok(
    diffApiSurface(previous, statusChanged).some(
      (entry) => entry.issueId === `route_contract_changed:${route.method} ${route.path}`,
    ),
  );

  const requestChanged = clone(baseline);
  const requestRoute = requestChanged.routes.find((entry) => entry.body.schemas.length > 0);
  assert.ok(requestRoute);
  requestRoute.body.schemas[0].signatureSha256 = "2".repeat(64);
  assert.ok(
    diffApiSurface(previous, requestChanged).some(
      (entry) =>
        entry.issueId === `route_contract_changed:${requestRoute.method} ${requestRoute.path}`,
    ),
  );
});

test("禁止身份检查覆盖alias、resolved symbol、声明来源和transitive签名", () => {
  assert.throws(
    () =>
      assertPublicContractIdentityAllowedForTest([
        "PublicRuntimeError",
        "RuntimeCredentialError",
        "packages/contracts/src/runtime-credential.ts",
      ]),
    /禁止/u,
  );
  assert.throws(
    () =>
      assertPublicContractIdentityAllowedForTest([
        "PublicSafeAlias",
        "type PublicSafeAlias = { credential: RuntimeCredentialError }",
      ]),
    /禁止/u,
  );
});

test("所有package export subpath独立冻结key/target/conditions/symbol与transitive hash", () => {
  const application = baseline.packageExports.find((entry) => entry.name === "@chat/application");
  assert.ok(application);
  assert.equal(application.subpaths.length, application.exportPaths.length);
  for (const pkg of baseline.packageExports) {
    assert.equal(pkg.subpaths.length, pkg.exportPaths.length);
    for (const subpath of pkg.subpaths) {
      assert.equal(typeof subpath.key, "string");
      assert.equal(typeof subpath.target, "string");
      assert.ok(["public", "internal"].includes(subpath.visibility));
      assert.ok(Array.isArray(subpath.exportedSymbols));
      assert.match(subpath.transitiveSignatureSha256, /^[0-9a-f]{64}$/u);
    }
  }
  const fixture = application.subpaths.find((entry) => entry.key === "./workflow-kernel-fixtures");
  assert.ok(fixture);
  const changed = clone(baseline);
  changed.packageExports
    .find((entry) => entry.name === "@chat/application")
    .subpaths.find(
      (entry) => entry.key === "./workflow-kernel-fixtures",
    ).transitiveSignatureSha256 = "9".repeat(64);
  assert.ok(
    diffApiSurface(baseline, changed)
      .map((entry) => entry.issueId)
      .includes("package_export_changed:@chat/application:./workflow-kernel-fixtures"),
  );
  const runtime = baseline.packageExports
    .find((entry) => entry.name === "@chat/contracts")
    .subpaths.find((entry) => entry.key === "./runtime-credential");
  assert.equal(runtime.visibility, "internal");
});

test("Manifest升代产生meta change且不能绕过route/response/export精确waiver", () => {
  const changed = clone(baseline);
  changed.schemaVersion = "chat-public-api-surface.v3";
  changed.routes[0].successfulResponses[0].status = "299";
  const subpath = changed.packageExports.find((entry) => entry.subpaths.length > 0).subpaths[0];
  subpath.target = "./src/replacement.ts";
  subpath.conditions = { import: "./src/replacement.ts", types: "./src/replacement.ts" };
  const issues = diffApiSurface(baseline, changed);
  const ids = issues.map((entry) => entry.issueId);
  assert.ok(ids.includes("manifest_schema_version_changed:api-surface-manifest"));
  assert.ok(ids.some((id) => id.startsWith("route_contract_changed:")));
  assert.ok(ids.some((id) => id.startsWith("package_export_changed:")));
  assert.throws(
    () => assertApiSurfaceCompatible(baseline, changed, emptyWaivers),
    /未获用户明确批准/u,
  );
  const waivers = issues.map((entry) => ({
    issueKind: entry.kind,
    target: entry.target,
    baseDigest: entry.baseDigest,
    currentDigest: entry.currentDigest,
    diffSha256: entry.diffSha256,
    approvedBy: "user:fixture",
    approvalReference: "fixture:exact",
    detect: "manifest diff",
    why: "fixture",
    fix: "fixture migration",
    verify: "fixture contract",
    rollback: "restore fixture",
  }));
  assert.deepEqual(
    assertApiSurfaceCompatible(baseline, changed, { schemaVersion: 2, waivers }),
    issues,
  );
  const unknown = clone(changed);
  unknown.schemaVersion = "chat-public-api-surface.v99";
  assert.throws(() => diffApiSurface(baseline, unknown), /normalizer/u);
});

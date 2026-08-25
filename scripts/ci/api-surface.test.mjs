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
  applicationOperationsFromFixtureForTest,
  classifySchemaRolesForTest,
  diffApiSurface,
  generateApiSurface,
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
  assert.equal(first.routes.length, 106);
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
        Array.isArray(route.applicationOperations) &&
        Array.isArray(route.applicationOperationContracts) &&
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

test("Application fallback响应和非Schema公开符号签名变化均失败关闭", () => {
  const current = clone(baseline);
  const fallbackRoute = current.routes.find((route) =>
    route.responseSchemas.some((response) => response.identity.startsWith("application-result:")),
  );
  assert.ok(fallbackRoute);
  fallbackRoute.responseSchemas[0].signatureSha256 = "a".repeat(64);
  const symbol = current.publicSymbols.find((entry) => entry.kind !== "schema");
  assert.ok(symbol);
  symbol.signatureSha256 = "b".repeat(64);
  const issueIds = diffApiSurface(baseline, current).map((entry) => entry.issueId);
  assert.ok(
    issueIds.includes(`route_contract_changed:${fallbackRoute.method} ${fallbackRoute.path}`),
  );
  assert.ok(issueIds.includes(`public_symbol_changed:${symbol.name}`));
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

test("Application operation替换与package export目标/条件变化都进入diff", () => {
  const changed = clone(baseline);
  changed.routes[0].applicationOperations = ["replacementOperation"];
  const exported = changed.packageExports.find((entry) => entry.exportPaths.length > 0);
  assert.ok(exported);
  const key = exported.exportPaths[0];
  exported.exports[key] = { import: "./src/replacement.ts", types: "./src/replacement.ts" };
  const ids = diffApiSurface(baseline, changed).map((entry) => entry.issueId);
  assert.ok(ids.some((id) => id.startsWith("route_contract_changed:")));
  assert.ok(ids.includes(`package_export_changed:${exported.name}:${key}`));
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

test("route沿本地/import helper调用图收敛并让底层Operation替换进入合同", () => {
  const application = `
    export async function getNote() { return { kind: "note" as const }; }
    export async function getNoteHistory() { return { kind: "history" as const }; }
  `;
  const route = `
    import { helper } from "./fixture-helper.js";
    export const handler = async () => helper();
  `;
  const helper = (operation) => `
    import { ${operation} } from "../../../../packages/application/src/fixture-use-cases.js";
    function cycleA() { return cycleB(); }
    function cycleB() { return cycleA(); }
    void cycleA;
    export async function helper() { return ${operation}(); }
  `;
  assert.deepEqual(
    applicationOperationsFromFixtureForTest({
      route,
      helper: helper("getNote"),
      application,
    }),
    ["getNote"],
  );
  assert.deepEqual(
    applicationOperationsFromFixtureForTest({
      route,
      helper: helper("getNoteHistory"),
      application,
    }),
    ["getNoteHistory"],
  );
  assert.throws(
    () =>
      applicationOperationsFromFixtureForTest({
        route,
        application,
        helper: `
          import { getNote, getNoteHistory } from "../../../../packages/application/src/fixture-use-cases.js";
          export function helper(condition = true) {
            const operation = condition ? getNote : getNoteHistory;
            return operation();
          }
        `,
      }),
    /无法静态解析|不是可静态解析/u,
  );
});

test("Application callback沿参数、解构和对象成员传播，动态值失败关闭", () => {
  const application = `
    export async function getNote() { return { kind: "note" as const }; }
    export async function getNoteHistory() { return { kind: "history" as const }; }
  `;
  const importedRoute = (operation) => `
    import { helper } from "./fixture-helper.js";
    import { ${operation} } from "../../../../packages/application/src/fixture-use-cases.js";
    export const handler = async () => helper({ operation: ${operation} });
  `;
  const destructuredHelper = `
    export async function helper({ operation }) { return operation(); }
  `;
  const note = applicationOperationsFromFixtureForTest({
    route: importedRoute("getNote"),
    helper: destructuredHelper,
    application,
  });
  const history = applicationOperationsFromFixtureForTest({
    route: importedRoute("getNoteHistory"),
    helper: destructuredHelper,
    application,
  });
  assert.deepEqual(note, ["getNote"]);
  assert.deepEqual(history, ["getNoteHistory"]);

  assert.deepEqual(
    applicationOperationsFromFixtureForTest({
      route: `
        import { getNote } from "../../../../packages/application/src/fixture-use-cases.js";
        const local = (operation) => operation();
        const callbacks = { run: getNote };
        export const handler = async () => local(callbacks.run);
      `,
      helper: "export {};",
      application,
    }),
    ["getNote"],
  );

  assert.deepEqual(
    applicationOperationsFromFixtureForTest({
      route: `
        import { helper } from "./fixture-helper.js";
        import { getNote } from "../../../../packages/application/src/fixture-use-cases.js";
        export const handler = async () => helper({ run: getNote });
      `,
      helper: `
        export async function helper(callbacks) {
          const { run } = callbacks;
          return run();
        }
      `,
      application,
    }),
    ["getNote"],
  );

  assert.throws(
    () =>
      applicationOperationsFromFixtureForTest({
        route: `
          import { helper } from "./fixture-helper.js";
          import { getNote, getNoteHistory } from "../../../../packages/application/src/fixture-use-cases.js";
          declare const condition: boolean;
          export const handler = async () => helper(condition ? getNote : getNoteHistory);
        `,
        helper: `export async function helper(operation) { return operation(); }`,
        application,
      }),
    /无法静态解析的动态调用/u,
  );

  const changed = clone(baseline);
  changed.routes[0].applicationOperations = note;
  const replacement = clone(changed);
  replacement.routes[0].applicationOperations = history;
  assert.ok(
    diffApiSurface(changed, replacement).some((entry) =>
      entry.issueId.startsWith("route_contract_changed:"),
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

test("Manifest升代产生meta change且不能绕过route/operation/export精确waiver", () => {
  const changed = clone(baseline);
  changed.schemaVersion = "chat-public-api-surface.v3";
  changed.routes[0].applicationOperations = ["replacementOperation"];
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

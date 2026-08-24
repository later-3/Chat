import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertApiSurfaceBaselineChain,
  assertApiSurfaceCompatible,
  diffApiSurface,
  generateApiSurface,
  validateWaivers,
} from "./api-surface.mjs";

const root = resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(
  readFileSync(resolve(root, "config/api-surface.baseline.json"), "utf8"),
);
const emptyWaivers = { schemaVersion: 1, waivers: [] };

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
  assert.doesNotMatch(
    JSON.stringify(first),
    /(?:\/internal\/runtime|runtime-credential|hookToken|workflowRunId|piRuntimeSessionId|apiKey|promptText)/u,
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
  assert.ok(issueIds.includes("problem_codes_changed:ProblemCode"));
  assert.throws(
    () => assertApiSurfaceCompatible(baseline, current, emptyWaivers),
    /未获用户明确批准/u,
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
    () => assertApiSurfaceBaselineChain(baseline, changed, changed, emptyWaivers),
    new RegExp(`route_removed:${removed.method} ${removed.path}`, "u"),
  );
  assert.deepEqual(assertApiSurfaceBaselineChain(undefined, baseline, baseline, emptyWaivers), []);
});

test("breaking change豁免必须记录用户批准和detect/why/fix/verify/rollback", () => {
  assert.throws(
    () =>
      validateWaivers({
        schemaVersion: 1,
        waivers: [
          {
            issueId: "route_removed:GET /api/example",
            approvedBy: "agent:codex",
            approvalReference: "thread",
            detect: "route diff",
            why: "example",
            fix: "migrate",
            verify: "contract",
            rollback: "restore",
          },
        ],
      }),
    /明确用户批准/u,
  );
  assert.throws(
    () =>
      validateWaivers({
        schemaVersion: 1,
        waivers: [
          {
            issueId: "route_removed:GET /api/example",
            approvedBy: "user:later",
            approvalReference: "thread",
            detect: "route diff",
            why: "example",
            fix: "migrate",
            verify: "contract",
          },
        ],
      }),
    /rollback/u,
  );
});

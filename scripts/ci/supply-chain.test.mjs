import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  assertActualManagedLinks,
  assertNoManagedClosureVulnerabilities,
  classifyPnpmWorkspaceAudit,
  runSupplyChainCheck,
  scanTrackedSecrets,
  validateAuditJsonResult,
  validateSupplyChainPolicy,
} from "./supply-chain.mjs";
import { loadManagedSourcesManifest } from "./managed-sources.mjs";

const root = resolve(import.meta.dirname, "../..");
const policy = JSON.parse(readFileSync(resolve(root, "config/supply-chain-policy.json"), "utf8"));

test("最低供应链门锁定三仓、lifecycle、secret与production license", () => {
  const report = runSupplyChainCheck();
  assert.deepEqual(
    report.managedSources.map((entry) => entry.id),
    ["pi", "dsh"],
  );
  assert.equal(report.secrets.findingCount, 0);
  assert.ok(report.licenses.chat.packageCount > 100);
  assert.ok(report.licenses.pi.packageCount > 100);
  assert.ok(report.licenses.dsh.packageCount >= 3);
  assert.deepEqual(Object.keys(report.licenses), ["chat", "pi", "dsh"]);
  assert.deepEqual(report.onlyBuiltDependencies, ["@deepseek-ai/dsh-subprocess-local", "node-pty"]);
});

test("DSH whole-fork债务与Chat实际链接闭包机械分离，真实闭包注入失败", () => {
  const report = {
    metadata: { vulnerabilities: { high: 2 } },
    advisories: {
      unrelated: {
        module_name: "unrelated-vulnerable-package",
        severity: "high",
        findings: [{ paths: ["packages__e2b__e2b>unrelated-vulnerable-package"] }],
      },
      injected: {
        module_name: "injected-vulnerable-package",
        severity: "high",
        findings: [
          {
            paths: ["packages__client__ui-trajectory>injected-vulnerable-package"],
          },
        ],
      },
    },
  };
  const classification = classifyPnpmWorkspaceAudit(report, ["packages/client/ui-trajectory"]);
  assert.deepEqual(
    classification.inClosure.map((entry) => entry.advisoryId),
    ["injected"],
  );
  assert.deepEqual(
    classification.outsideClosure.map((entry) => entry.advisoryId),
    ["unrelated"],
  );
  assert.throws(
    () => assertNoManagedClosureVulnerabilities(classification, "DSH"),
    /真实闭包命中1个漏洞/u,
  );
});

test("供应链policy拒绝无理由lifecycle和无审查许可证例外", () => {
  const missingReason = structuredClone(policy);
  missingReason.onlyBuiltDependencies[0].reason = "";
  assert.throws(() => validateSupplyChainPolicy(missingReason), /说明理由/u);

  const missingLicenseReason = structuredClone(policy);
  missingLicenseReason.reviewedLicenseExceptions[0].reason = "";
  assert.throws(() => validateSupplyChainPolicy(missingLicenseReason), /reason/u);

  const unboundedLicensePattern = structuredClone(policy);
  unboundedLicensePattern.reviewedLicenseExceptions[0].name = "@img/*-libvips-*";
  assert.throws(() => validateSupplyChainPolicy(unboundedLicensePattern), /尾随\*/u);
});

test("secret scan覆盖全部tracked与未提交文件且当前0命中", () => {
  const result = scanTrackedSecrets();
  assert.equal(result.findingCount, 0);
  assert.ok(result.fileCount > 300);
});

function pnpmAudit(overrides = {}) {
  return {
    advisories: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
    ...overrides,
  };
}

function npmAuditWithOneVulnerability() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      vulnerable: {
        name: "vulnerable",
        severity: "high",
        via: ["GHSA-example"],
        effects: [],
        range: "<2.0.0",
        nodes: ["node_modules/vulnerable"],
        fixAvailable: false,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
      dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
    },
  };
}

test("audit只接受exit 0零漏洞或exit 1合法漏洞事实", () => {
  assert.deepEqual(
    validateAuditJsonResult({
      command: "pnpm audit",
      status: 0,
      stdout: JSON.stringify(pnpmAudit()),
    }),
    pnpmAudit(),
  );
  const npmVulnerable = npmAuditWithOneVulnerability();
  assert.deepEqual(
    validateAuditJsonResult({
      command: "npm audit",
      status: 1,
      stdout: JSON.stringify(npmVulnerable),
    }),
    npmVulnerable,
  );
});

test("pnpm/npm错误JSON、缺字段、非法输出与状态内容矛盾全部失败关闭", () => {
  const validPnpmAdvisory = {
    id: 1,
    module_name: "vulnerable",
    vulnerable_versions: "<2.0.0",
    patched_versions: ">=2.0.0",
    severity: "high",
    findings: [{ version: "1.0.0", paths: ["packages__client__ui-trajectory>vulnerable"] }],
  };
  const vulnerablePnpm = pnpmAudit({
    advisories: { 1: validPnpmAdvisory },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
  });
  const cases = [
    { status: 1, stdout: JSON.stringify({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } }) },
    { status: 1, stdout: JSON.stringify({ error: { code: "EAUDITERROR", summary: "npm error" } }) },
    { status: 0, stdout: JSON.stringify({ advisories: {} }) },
    { status: 0, stdout: JSON.stringify({ metadata: pnpmAudit().metadata }) },
    {
      status: 1,
      stdout: JSON.stringify({
        ...vulnerablePnpm,
        advisories: { 1: { ...validPnpmAdvisory, vulnerable_versions: undefined } },
      }),
    },
    { status: 0, stdout: JSON.stringify(vulnerablePnpm) },
    { status: 1, stdout: JSON.stringify(pnpmAudit()) },
    { status: 0, stdout: "not-json" },
    { status: 1, stdout: "" },
    { status: 2, stdout: JSON.stringify(pnpmAudit()), stderr: "network unavailable" },
    {
      status: 0,
      stdout: JSON.stringify({
        ...npmAuditWithOneVulnerability(),
        vulnerabilities: {
          vulnerable: {
            ...npmAuditWithOneVulnerability().vulnerabilities.vulnerable,
            severity: "critical",
          },
        },
        metadata: {
          ...npmAuditWithOneVulnerability().metadata,
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        },
      }),
    },
    {
      status: 1,
      stdout: JSON.stringify({
        ...vulnerablePnpm,
        metadata: {
          ...vulnerablePnpm.metadata,
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 },
        },
      }),
    },
  ];
  for (const fixture of cases) {
    assert.throws(() =>
      validateAuditJsonResult({ command: "audit fixture", stderr: "", ...fixture }),
    );
  }
});

test("Chat实际Fork link与Manifest必须在漏洞分类前双向精确相等", () => {
  const manifest = loadManagedSourcesManifest();
  const actual = assertActualManagedLinks(manifest);
  assert.equal(actual.pi.length, 3);
  assert.equal(actual.dsh.length, 1);

  const undeclared = structuredClone(manifest);
  undeclared.sources.find((source) => source.id === "dsh").linkedPackages = [];
  assert.throws(() => assertActualManagedLinks(undeclared), /不双向相等/u);
});

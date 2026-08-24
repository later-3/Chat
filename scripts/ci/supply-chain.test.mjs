import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  runSupplyChainCheck,
  scanTrackedSecrets,
  validateSupplyChainPolicy,
} from "./supply-chain.mjs";

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
  assert.ok(report.licenses.dsh.packageCount > 500);
  assert.deepEqual(Object.keys(report.licenses), ["chat", "pi", "dsh"]);
  assert.deepEqual(report.onlyBuiltDependencies, ["@deepseek-ai/dsh-subprocess-local", "node-pty"]);
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkDecisionRecords,
  validateDecisionIndex,
  validateDecisionRecordSource,
} from "./decision-records.mjs";

test("ADR索引、模板、状态和必需章节完整", () => {
  const records = checkDecisionRecords();
  assert.equal(records.length, 3);
  assert.ok(records.every((record) => record.status === "accepted"));
});

test("ADR拒绝非法状态、错号和缺回滚章节", () => {
  const valid = `# ADR-0099: 示例\n\n- 状态：proposed\n- 日期：2026-08-24\n- 适用范围：示例\n- 决策所有者：用户\n\n## 背景\nA\n## 决定\nB\n## 后果\nC\n## 替代方案\nD\n## 变更与回滚\nE\n`;
  assert.equal(validateDecisionRecordSource(valid, "0099-example.md").status, "proposed");
  assert.throws(
    () => validateDecisionRecordSource(valid.replace("proposed", "done"), "0099-example.md"),
    /状态/u,
  );
  assert.throws(() => validateDecisionRecordSource(valid, "0100-example.md"), /编号/u);
  assert.throws(
    () =>
      validateDecisionRecordSource(valid.replace("## 变更与回滚", "## 回滚"), "0099-example.md"),
    /变更与回滚/u,
  );
});

test("ADR索引拒绝漏项和状态漂移", () => {
  assert.throws(
    () =>
      validateDecisionIndex("| 0099 | 示例 | accepted | [ADR-0099](./0099-example.md) |", [
        { number: "0099", status: "proposed", filename: "0099-example.md" },
      ]),
    /索引缺失或状态漂移/u,
  );
});

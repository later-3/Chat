import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");

describe("CI workflow baseline", () => {
  it("pins every action to a full commit SHA", () => {
    const actionRefs = [...workflow.matchAll(/^\s*- uses: ([^\s]+)(?: # .+)?$/gmu)].map(
      (match) => match[1],
    );
    assert.ok(actionRefs.length > 0);
    for (const actionRef of actionRefs) assert.match(actionRef, /@[0-9a-f]{40}$/u);
  });

  it("declares read-only permissions and cancellable concurrency", () => {
    assert.match(workflow, /^permissions:\n  contents: read$/mu);
    assert.match(workflow, /^concurrency:\n  group: .+\n  cancel-in-progress: true$/mu);
  });

  it("clears Provider credentials and prepares managed sources in every job", () => {
    for (const name of ["DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"]) {
      assert.match(workflow, new RegExp(`^  ${name}: ""$`, "mu"));
    }
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
    const jobCount = [...jobs.matchAll(/^  [a-z][a-z0-9-]+:\n    /gmu)].length;
    const prepareCount = [...workflow.matchAll(/run: pnpm managed-sources:prepare/gu)].length;
    assert.equal(prepareCount, jobCount);
  });
});

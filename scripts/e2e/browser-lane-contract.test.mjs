import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const testCount = (path) => [...read(path).matchAll(/\btest\("/gu)].length;

describe("deterministic browser lane contract", () => {
  it("reuses the only Playwright config and the managed mode runner", () => {
    const configs = readdirSync(resolve(repoRoot, "apps/dsh-web")).filter((name) =>
      /^playwright.*\.config\.ts$/u.test(name),
    );
    assert.deepEqual(configs, ["playwright.dsh-real.config.ts"]);
    const root = JSON.parse(read("package.json"));
    assert.equal(
      root.scripts["test:browser"],
      "pnpm test:browser:pwa-mobile && pnpm test:browser:planning && pnpm test:browser:prompt-studio && pnpm test:browser:trajectory && pnpm test:browser:project-bootstrap && pnpm test:browser:capability-governance",
    );
    for (const [name, command] of Object.entries(root.scripts)) {
      if (name === "test:browser" || name.startsWith("test:browser:")) {
        assert.equal(typeof command, "string");
        assert.doesNotMatch(command, /:paid|:external:|workbench/iu);
      }
    }
  });

  it("keeps the required 7 + 1 + 3 Chromium cases and existing deterministic surfaces", () => {
    assert.equal(
      testCount("apps/dsh-web/e2e/dsh-pwa-real.spec.ts") +
        testCount("apps/dsh-web/e2e/dsh-mobile-hanui-real.spec.ts"),
      7,
    );
    assert.equal(testCount("apps/dsh-web/e2e/dsh-project-bootstrap-real.spec.ts"), 1);
    assert.equal(testCount("apps/dsh-web/e2e/dsh-capability-governance-real.spec.ts"), 3);
    assert.equal(testCount("apps/dsh-web/e2e/dsh-planning-faux-real.spec.ts"), 1);
    assert.ok(testCount("apps/dsh-web/e2e/dsh-prompt-studio-real.spec.ts") >= 1);
    assert.ok(testCount("apps/dsh-web/e2e/dsh-trajectory-real.spec.ts") >= 1);
  });

  it("separates paid planning from beta Workbench and gives deterministic modes an allowlist", () => {
    const planning = read("apps/dsh-web/e2e/dsh-planning-real.spec.ts");
    assert.doesNotMatch(planning, /dsh-workbench-real-helper|exerciseDshWorkbench/u);
    const config = read("apps/dsh-web/playwright.dsh-real.config.ts");
    assert.match(config, /paidMode \? process\.env : deterministicDataEnvironment/u);
    assert.match(config, /workbenchOnly\s*\? \[codeServer, dshWorkbench\]/u);
    assert.match(config, /\[piExecutor, workflow, api, dsh\]/u);
    assert.match(config, /deterministicBrowserProcessEnvironment/u);
  });
});

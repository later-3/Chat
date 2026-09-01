import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const workflowRequire = createRequire(import.meta.resolve("workflow"));

test("Workflow Builder preserves JSON import attributes in executable module graphs", async () => {
  const builderEntry = workflowRequire.resolve("@workflow/builders");
  const { applySwcTransform } = await import(pathToFileURL(builderEntry).href);
  const fixturePath = fileURLToPath(new URL(
    "./memory/agents/memory-agent/index.ts",
    import.meta.url,
  ));
  const source = await readFile(fixturePath, "utf8");

  for (const mode of [false, "step"]) {
    const transformed = await applySwcTransform(
      fixturePath,
      source,
      mode,
      fixturePath,
      process.cwd(),
      process.cwd(),
    );
    assert.match(
      transformed.code,
      /from\s+["']\.\/agent\.json["']\s+with\s*\{\s*type:\s*["']json["']\s*\}/,
      `@workflow/builders must preserve import attributes in ${String(mode)} mode`,
    );
  }
});

test("Nitro dev step bundle embeds local Agent JSON configs and loads in Node", async (t) => {
  const buildDir = await mkdtemp(resolve("node_modules", ".nitro-workflow-test-"));
  t.after(() => rm(buildDir, { recursive: true, force: true }));

  const nitroEntry = workflowRequire.resolve("@workflow/nitro");
  const nitroBuildersEntry = join(dirname(nitroEntry), "builders.js");
  const { LocalBuilder } = await import(pathToFileURL(nitroBuildersEntry).href);
  const rootDir = process.cwd();
  const nitro = {
    options: {
      buildDir,
      rootDir,
      workspaceDir: rootDir,
      dev: true,
      workflow: { dirs: ["src/workflows"] },
    },
  };

  await new LocalBuilder(nitro).build();
  const stepsPath = join(buildDir, "workflow", "steps.mjs");
  const steps = await readFile(stepsPath, "utf8");

  assert.doesNotMatch(
    steps,
    /^import .*agent\.json.*$/gm,
    "Nitro dev must not leave Agent JSON as a raw runtime import",
  );
  for (const name of ["Memory Agent", "Planner Agent", "Rule Curator Agent"]) {
    assert.match(steps, new RegExp(`name: ["']${name}["']`));
  }
  assert.equal(steps.match(/name: ["']Pi Coding Agent["']/g)?.length, 2);

  await import(`${pathToFileURL(stepsPath).href}?test=${Date.now()}`);
});

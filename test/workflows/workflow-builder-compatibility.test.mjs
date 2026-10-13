import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { loadOptions } from "nitro/builder";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const workflowRequire = createRequire(import.meta.resolve("workflow"));

test("Workflow Builder preserves JSON import attributes in executable module graphs", async () => {
  const builderEntry = workflowRequire.resolve("@workflow/builders");
  const { applySwcTransform } = await import(pathToFileURL(builderEntry).href);
  const fixturePath = fileURLToPath(new URL(
    "../../src/workflows/memory/agents/memory-agent/index.ts",
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


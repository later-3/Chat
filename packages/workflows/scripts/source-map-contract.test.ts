import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertWorkflowBundleSourceMaps } from "./source-map-contract.js";

const packageDir = resolve(fileURLToPath(import.meta.url), "../..");

function inlineMap(sources: readonly string[]): string {
  const encoded = Buffer.from(
    JSON.stringify({
      version: 3,
      sources,
      sourcesContent: sources.map((source) => `// ${source}`),
      names: [],
      mappings: "",
    }),
  ).toString("base64");
  return `//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
}

describe("Workflow Source Map合同", () => {
  it("真实Workflow与Step bundle都能映射回TypeScript源码", async () => {
    const bundleDir = process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? join(packageDir, ".workflow-bundle");
    await expect(assertWorkflowBundleSourceMaps(bundleDir)).resolves.toBeUndefined();
  });

  it("缺少内联Map时失败关闭", async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), "chat-workflow-source-map-"));
    await Promise.all([
      writeFile(join(bundleDir, "workflows.mjs"), "export const POST = () => {};\n", "utf8"),
      writeFile(join(bundleDir, "steps.mjs"), "export const POST = () => {};\n", "utf8"),
    ]);
    await expect(assertWorkflowBundleSourceMaps(bundleDir)).rejects.toThrow(
      "缺少Workflow Builder内联Source Map",
    );
  });

  it("接受debug隔离目录产生的更深相对源码路径", async () => {
    const bundleDir = await mkdtemp(join(tmpdir(), "chat-workflow-source-map-"));
    await Promise.all([
      writeFile(
        join(bundleDir, "workflows.mjs"),
        inlineMap([
          "src/configurable-planning-workflow.ts",
          "src/planning-execution-workflow.ts",
          "../contracts/src/product.ts",
        ]),
        "utf8",
      ),
      writeFile(
        join(bundleDir, "steps.mjs"),
        inlineMap([
          "../../src/workflow-planning-steps.ts",
          "../../src/workflow-execution-steps.ts",
          "../../src/workflow-result-steps.ts",
        ]),
        "utf8",
      ),
    ]);
    await expect(assertWorkflowBundleSourceMaps(bundleDir)).resolves.toBeUndefined();
  });
});

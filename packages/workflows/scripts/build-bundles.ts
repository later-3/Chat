import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseBuilder, createBaseBuilderConfig } from "@workflow/builders";

/**
 * 预构建Workflow/Step bundle（任务书§17：真实Vercel Workflow运行时）。
 *
 * 产物（gitignored）：
 * - .workflow-bundle/workflows.mjs：workflow编排入口（SWC转换后）
 * - .workflow-bundle/steps.mjs：step入口；非step模块保持external，
 *   由运行时经tsx解析到TS源码，VS Code断点直接命中TypeScript。
 * - .workflow-bundle/manifest.json：workflowId解析与版本证据。
 *
 * 启动Workflow Runtime或运行集成测试前必须执行本脚本
 * （pnpm --filter @chat/workflows build:bundles）。
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? join(packageDir, ".workflow-bundle");

class ChatWorkflowBuilder extends BaseBuilder {
  readonly #outDir: string;

  constructor(workingDir: string, bundleOutDir: string) {
    super({
      ...createBaseBuilderConfig({ workingDir, dirs: ["src"] }),
      buildTarget: "next",
      suppressCreateWorkflowsBundleLogs: true,
      suppressCreateWebhookBundleLogs: true,
      suppressCreateManifestLogs: true,
    });
    this.#outDir = bundleOutDir;
  }

  override async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await mkdir(this.#outDir, { recursive: true });
    await this.createStepsBundle({
      outfile: join(this.#outDir, "steps.mjs"),
      externalizeNonSteps: true,
      rewriteTsExtensions: true,
      format: "esm",
      inputFiles,
    });
    const { manifest } = await this.createWorkflowsBundle({
      outfile: join(this.#outDir, "workflows.mjs"),
      bundleFinalOutput: false,
      format: "esm",
      inputFiles,
    });
    await writeFile(join(this.#outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
}

const builder = new ChatWorkflowBuilder(packageDir, outDir);
await builder.build();
console.log(`workflow bundles written to ${outDir}`);

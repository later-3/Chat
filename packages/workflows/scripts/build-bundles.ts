import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseBuilder, createBaseBuilderConfig } from "@workflow/builders";
import {
  MODEL_CONFIG_VERSION,
  PLANNER_PROMPT_TEMPLATE_VERSION,
  EXECUTOR_PROMPT_TEMPLATE_VERSION,
  WORKFLOW_DEFINITION_VERSION,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
  PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION,
  PROJECT_ADVANCEMENT_WORKFLOW_DEFINITION_VERSION,
  DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
  runtimeBuildEvidenceSchema,
} from "@chat/contracts";
import {
  CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
  LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
  NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
} from "../src/definition-kernel-executor-registry.js";
import { assertWorkflowBundleSourceMaps } from "./source-map-contract.js";

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
const repoRoot = resolve(packageDir, "../..");
const outDir = process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? join(packageDir, ".workflow-bundle");
const sourceRoots = [
  "packages/contracts/src",
  "packages/domain/src",
  "packages/application/src",
  "packages/memory-runtime/src",
  "packages/pi-runtime/src",
  "packages/workflows/src",
] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && !entry.name.includes(".test.") ? [path] : [];
    }),
  );
  return files.flat().sort();
}

async function manifestSha256(files: readonly string[], root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file.slice(root.length + 1));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

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
    // Builder升级若丢失VM/Step内联Map，VS Code会静默退回生成Bundle；构建时直接失败关闭。
    await assertWorkflowBundleSourceMaps(this.#outDir);
    await writeFile(join(this.#outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    const gitSha =
      process.env.CHAT_GIT_SHA ??
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    const trackedSources = (
      await Promise.all(sourceRoots.map((root) => sourceFiles(join(repoRoot, root))))
    ).flat();
    const sourceManifestSha256 = await manifestSha256(trackedSources, repoRoot);
    const bundleManifestSha256 = await manifestSha256(
      [
        join(this.#outDir, "manifest.json"),
        join(this.#outDir, "steps.mjs"),
        join(this.#outDir, "workflows.mjs"),
      ],
      this.#outDir,
    );
    const sourceState =
      execFileSync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all", "--", ...sourceRoots],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      ).trim() === ""
        ? "clean"
        : "dirty";
    const evidence = runtimeBuildEvidenceSchema.parse({
      schemaVersion: "chat-runtime-build-evidence.v1",
      builtAt: new Date().toISOString(),
      gitSha,
      sourceState,
      sourceManifestSha256,
      bundleManifestSha256,
      workflowDefinitionVersions: [
        WORKFLOW_DEFINITION_VERSION,
        LEGACY_PLANNING_RUNNER_BUNDLE_VERSION,
        CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION,
        NOTE_CAPTURE_RUNNER_BUNDLE_VERSION,
        DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
        MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
        MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
        PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION,
        PROJECT_ADVANCEMENT_WORKFLOW_DEFINITION_VERSION,
      ],
      promptTemplateVersions: [
        PLANNER_PROMPT_TEMPLATE_VERSION,
        EXECUTOR_PROMPT_TEMPLATE_VERSION,
        DIRECT_AGENT_PROMPT_TEMPLATE_VERSION,
      ],
      modelConfigVersions: [MODEL_CONFIG_VERSION],
    });
    await writeFile(
      join(this.#outDir, "runtime-build-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
}

const builder = new ChatWorkflowBuilder(packageDir, outDir);
await builder.build();
console.log(`workflow bundles written to ${outDir}`);

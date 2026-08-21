import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("跨层依赖与事实所有权架构门", () => {
  it("Domain保持纯TypeScript，不依赖合同Schema或Adapter框架", async () => {
    const files = await productionTypescriptFiles("packages/domain/src");
    const violations = await findImportViolations(files, [
      /^@chat\//u,
      /^zod$/u,
      /^hono(?:\/|$)/u,
      /^react(?:\/|$)/u,
      /^workflow(?:\/|$)/u,
      /^@workflow\//u,
      /^@ag-ui\//u,
    ]);
    expect(violations).toEqual([]);
  });

  it("DSH Bridge只依赖公开合同，不导入Application、Store、Workflow或pi Runtime", async () => {
    const files = await productionTypescriptFiles("packages/dsh-lifeos-bridge/src");
    const violations = await findImportViolations(files, [
      /^@chat\/contracts$/u,
      /^@chat\/application(?:\/|$)/u,
      /^@chat\/product-store-json(?:\/|$)/u,
      /^@chat\/workflows(?:\/|$)/u,
      /^@chat\/pi-runtime(?:\/|$)/u,
      /^workflow(?:\/|$)/u,
      /^@workflow\//u,
    ]);
    expect(violations).toEqual([]);
  });

  it("Workflow Adapter不打开Product Store，Step不取得JSON文件或Store实现", async () => {
    const files = await productionTypescriptFiles("packages/workflows/src");
    const violations = await findTextViolations(files, [
      /@chat\/product-store-json/u,
      /JsonProductStore/u,
      /productSnapshotSchema/u,
      /createEmptySnapshot/u,
    ]);
    expect(violations).toEqual([]);
  });

  it("Hono Router不直接提交Product Store事务", async () => {
    const candidates = (await productionTypescriptFiles("apps/api/src")).filter((file) =>
      /(?:router|routes|app)\.tsx?$/u.test(file),
    );
    const violations = await findTextViolations(candidates, [
      /\bstore\.transact\s*\(/u,
      /\bdraft\.entities\b/u,
      /new\s+JsonProductStore/u,
    ]);
    expect(violations).toEqual([]);
  });

  it("DSH Bridge源码不出现私有Runtime身份字段", async () => {
    const files = await productionTypescriptFiles("packages/dsh-lifeos-bridge/src");
    const violations = await findTextViolations(files, [
      /workflowRunId/u,
      /hookToken/u,
      /runtimeCredential/u,
      /piSessionId/u,
      /providerPayload/u,
      /hiddenReasoning/u,
    ]);
    expect(violations).toEqual([]);
  });

  it("API、Workflow与Pi包根不加载完整Pi Coding Agent运行时", async () => {
    const apiAndWorkflowFiles = [
      ...(await productionTypescriptFiles("apps/api/src")),
      ...(await productionTypescriptFiles("packages/workflows/src")),
    ];
    const violations = await findTextViolations(apiAndWorkflowFiles, [
      /@chat\/pi-runtime\/coding-executor/u,
      /@earendil-works\/pi-coding-agent/u,
      /coding-agent-runtime-profile/u,
    ]);
    const piRoot = await readFile(
      resolve(REPOSITORY_ROOT, "packages/pi-runtime/src/index.ts"),
      "utf8",
    );

    expect(violations).toEqual([]);
    expect(piRoot).not.toContain("coding-agent-runtime-profile");
    expect(piRoot).not.toContain("coding-agent-executor");
    expect(piRoot).not.toContain("executor-service.js");
  });
});

async function productionTypescriptFiles(relativeDirectory: string): Promise<string[]> {
  const directory = resolve(REPOSITORY_ROOT, relativeDirectory);
  return (await walk(directory)).filter(
    (file) =>
      /\.tsx?$/u.test(file) && !/\.(?:test|spec)\.tsx?$/u.test(file) && !file.endsWith(".d.ts"),
  );
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files.sort();
}

async function findImportViolations(
  files: readonly string[],
  forbidden: readonly RegExp[],
): Promise<string[]> {
  const violations: string[] = [];
  const importPattern = /(?:from\s+|import\s*)["']([^"']+)["']/gu;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier !== undefined && forbidden.some((pattern) => pattern.test(specifier))) {
        violations.push(`${relative(REPOSITORY_ROOT, file)} imports ${specifier}`);
      }
    }
  }
  return violations.sort();
}

async function findTextViolations(
  files: readonly string[],
  forbidden: readonly RegExp[],
): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(source)) {
        violations.push(`${relative(REPOSITORY_ROOT, file)} matches ${String(pattern)}`);
      }
    }
  }
  return violations.sort();
}

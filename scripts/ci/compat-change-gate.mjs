import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const COMPAT_RELEVANT_PREFIXES = Object.freeze([
  ".github/workflows/",
  "config/test-lanes.json",
  "packages/contracts/",
  "packages/domain/",
  "packages/memory-runtime/",
  "packages/product-store-json/",
  "packages/testing/",
  "packages/workflows/",
  "scripts/ci/",
]);

export function shouldRunCompat(eventName, changedFiles = []) {
  if (eventName === "push" || eventName === "schedule" || eventName === "workflow_dispatch") {
    return true;
  }
  if (eventName !== "pull_request") {
    throw new Error(`compat lane不支持的GitHub事件：${eventName}`);
  }
  return changedFiles.some((path) =>
    COMPAT_RELEVANT_PREFIXES.some((prefix) =>
      prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
    ),
  );
}

export function changedFilesBetween(baseSha, headSha, root = CHAT_ROOT) {
  if (!/^[0-9a-f]{40}$/u.test(baseSha) || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("compat lane需要完整40位base/head SHA");
  }
  return execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${baseSha}...${headSha}`],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
}

export function evaluateCompatGate(environment = process.env) {
  const eventName = environment.GITHUB_EVENT_NAME ?? "";
  const changedFiles =
    eventName === "pull_request"
      ? changedFilesBetween(environment.CHAT_CI_BASE_SHA ?? "", environment.CHAT_CI_HEAD_SHA ?? "")
      : [];
  return { run: shouldRunCompat(eventName, changedFiles), changedFiles };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const result = evaluateCompatGate();
    const output = process.env.GITHUB_OUTPUT;
    if (output === undefined || output.trim() === "") throw new Error("缺少GITHUB_OUTPUT");
    appendFileSync(output, `run=${result.run ? "true" : "false"}\n`);
    console.log(
      result.run
        ? `[compat] 运行：${process.env.GITHUB_EVENT_NAME}命中兼容门`
        : `[compat] 跳过：${result.changedFiles.length}个变更均不触及兼容责任`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

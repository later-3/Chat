import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CODING_AGENT_SDK_CAPABILITIES } from "@earendil-works/pi-coding-agent";

export const PI_FORK_REPOSITORY = "https://github.com/later-3/pi";
export const PI_FORK_BRANCH = "codex/later-custom";

/**
 * Executor启动前确认当前解析到Later维护的Pi接缝。缺失时必须停止启动，不能让
 * TypeScript可选字段把未实现的Provider Gate静默降级为普通模型调用。
 */
export function assertManagedPiForkCapabilities(): Readonly<{
  checkoutRoot: string;
  branch: string;
  origin: string;
}> {
  if (
    CODING_AGENT_SDK_CAPABILITIES.providerRequestGate !== 1 ||
    CODING_AGENT_SDK_CAPABILITIES.resumePendingTurn !== 1
  ) {
    throw new Error("当前Pi依赖不具备Chat要求的Provider Gate与Session恢复接缝");
  }

  const packageEntry = realpathSync(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
  );
  const checkoutRoot = realpathSync(
    execFileSync("git", ["-C", dirname(packageEntry), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  const branch = execFileSync("git", ["-C", checkoutRoot, "branch", "--show-current"], {
    encoding: "utf8",
  }).trim();
  if (branch !== PI_FORK_BRANCH) {
    throw new Error(`Pi Fork分支必须是${PI_FORK_BRANCH}，实际为${branch || "detached"}`);
  }
  const origin = execFileSync("git", ["-C", checkoutRoot, "remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  if (origin !== "git@github.com:later-3/pi.git" && origin !== `${PI_FORK_REPOSITORY}.git`) {
    throw new Error(`Pi Fork origin不受管：${origin}`);
  }
  return Object.freeze({ checkoutRoot, branch, origin });
}

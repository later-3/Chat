import { createError, defineEventHandler, readBody } from "nitro/h3";
import { ensureChatDataLayout } from "../../../chat-data.js";
import { resolveResourceCwd, ResourceAccessError } from "../../../resources/access.js";
import { runNpx } from "../../../resources/npx.js";

const ANSI = /\x1B\[[0-9;]*m/g;

export default defineEventHandler(async (event) => {
  const body = await readBody<unknown>(event);
  if (typeof body !== "object" || body === null) {
    throw createError({ statusCode: 400, statusMessage: "请求体必须是对象" });
  }
  const value = body as { package?: unknown; scope?: unknown; cwd?: unknown };
  if (typeof value.package !== "string" || value.package.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "package必须是非空字符串" });
  }
  try {
    const global = value.scope !== "project";
    const cwd = global ? undefined : await resolveResourceCwd(value.cwd);
    const { agentDir } = await ensureChatDataLayout();
    const args = ["skills", "add", value.package.trim(), "-y", "--agent", "pi"];
    if (global) args.push("-g");
    const result = await runNpx(args, {
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: 60_000,
      env: { ...process.env, FORCE_COLOR: "0", PI_CODING_AGENT_DIR: agentDir },
    });
    const output = `${result.stdout}${result.stderr}`.replace(ANSI, "");
    if (!/Installation complete|Installed \d+ skill/i.test(output)) {
      throw new Error(output.slice(-500) || "Skill安装未返回成功状态");
    }
    return { success: true, output };
  } catch (error) {
    throw createError({
      statusCode: error instanceof ResourceAccessError ? error.statusCode : 500,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});

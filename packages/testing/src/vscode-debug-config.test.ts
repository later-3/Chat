import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * VS Code只负责调用仓库拥有的开发启动器并附加调试器。
 * 服务图、就绪等待和停止顺序不得再次复制到.vscode配置。
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

interface LaunchConfig {
  name: string;
  type?: string;
  request?: string;
  cwd?: string;
  program?: string;
  args?: string[];
  autoAttachChildProcesses?: boolean;
  console?: string;
  outputCapture?: string;
  preLaunchTask?: string;
  postDebugTask?: string;
  serverReadyAction?: {
    pattern?: string;
    action?: string;
    killOnServerStop?: boolean;
    config?: {
      name?: string;
      type?: string;
      request?: string;
      url?: string;
      webRoot?: string;
      userDataDir?: string;
      cleanUp?: string;
      killBehavior?: string;
    };
  };
}

const launch = JSON.parse(readFileSync(join(repoRoot, ".vscode/launch.json"), "utf8")) as {
  configurations: LaunchConfig[];
  compounds?: unknown[];
};
const appDebug = launch.configurations.find((config) => config.name === "Chat：调试应用");

describe("VS Code应用级调试配置", () => {
  it("只暴露一个应用入口，不再由tasks.json拥有服务生命周期", () => {
    expect(launch.configurations.map((config) => config.name)).toEqual(["Chat：调试应用"]);
    expect(launch.compounds ?? []).toEqual([]);
    expect(existsSync(join(repoRoot, ".vscode/tasks.json"))).toBe(false);
    expect(appDebug?.preLaunchTask).toBeUndefined();
    expect(appDebug?.postDebugTask).toBeUndefined();
  });

  it("调用与pnpm dev共享的仓库启动器并自动附加子进程", () => {
    expect(appDebug).toMatchObject({
      type: "node",
      request: "launch",
      cwd: "${workspaceFolder}",
      program: "${workspaceFolder}/scripts/dev/start.mjs",
      args: ["--debug"],
      autoAttachChildProcesses: true,
      console: "internalConsole",
      outputCapture: "std",
    });

    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.dev).toBe("node scripts/dev/start.mjs");
    expect(packageJson.scripts["dev:debug"]).toBe("node scripts/dev/start.mjs --debug");
    expect(packageJson.scripts["dev:status"]).toBe("node scripts/dev/status.mjs");
    expect(packageJson.scripts["dev:stop"]).toBe("node scripts/debug/stop.mjs");
  });

  it("应用Ready后才启动Chrome前端调试", () => {
    expect(appDebug?.serverReadyAction).toEqual({
      pattern: "\\[chat\\] ready: (http://127\\.0\\.0\\.1:43110/)",
      action: "startDebugging",
      killOnServerStop: true,
      config: {
        name: "Chat：前端浏览器（内部）",
        type: "pwa-chrome",
        request: "launch",
        url: "http://127.0.0.1:43110/",
        webRoot: "${workspaceFolder}/apps/web",
        userDataDir: "${workspaceFolder}/.data/debug/browser-profile",
        cleanUp: "wholeBrowser",
        killBehavior: "forceful",
      },
    });
  });

  it("浏览器使用worktree专属profile并随父会话停止", () => {
    const browser = appDebug?.serverReadyAction?.config;
    expect(browser?.userDataDir).toBe("${workspaceFolder}/.data/debug/browser-profile");
    expect(browser?.cleanUp).toBe("wholeBrowser");
    expect(browser?.killBehavior).toBe("forceful");
    expect(appDebug?.serverReadyAction?.killOnServerStop).toBe(true);
  });

  it("VS Code配置不包含服务参数、私密配置或Memory调试会话", () => {
    const raw = readFileSync(join(repoRoot, ".vscode/launch.json"), "utf8");
    expect(raw).not.toContain("Chat：Memory");
    expect(raw).not.toContain("Chat：Workflow");
    expect(raw).not.toContain("Chat：API");
    expect(raw).not.toContain("envFile");
    expect(raw).not.toContain("DASHSCOPE_API_KEY");
    expect(raw).not.toContain("CHAT_TENCENT_MEMORYCORE_TOKEN");
    expect(raw).not.toContain("Bearer ");

    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toContain("!.vscode/launch.json");
    expect(gitignore).not.toContain("!.vscode/tasks.json");
  });
});

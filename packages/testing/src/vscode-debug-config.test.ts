import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * VS Code调试配置合同测试（任务书§8.3）。
 *
 * 固定：Compound存在统一preclean门（先于所有子会话执行），
 * 随后等待链保证 Workflow -> API -> Web 顺序；子配置保留单独启动能力。
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");

interface LaunchConfig {
  name: string;
  type?: string;
  preLaunchTask?: string;
  postDebugTask?: string;
  port?: number;
  env?: Record<string, string>;
  url?: string;
}

interface Compound {
  name: string;
  configurations: string[];
  preLaunchTask?: string;
  stopAll?: boolean;
}

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, unknown>;
}

const launch = readJson(".vscode/launch.json") as unknown as {
  configurations: LaunchConfig[];
  compounds: Compound[];
};
const tasks = readJson(".vscode/tasks.json") as unknown as {
  tasks: Array<{ label: string; dependsOn?: string[] }>;
};

function configOf(name: string): LaunchConfig {
  const found = launch.configurations.find((config) => config.name === name);
  if (!found) throw new Error(`launch.json缺少配置: ${name}`);
  return found;
}

describe("VS Code调试配置", () => {
  it("主Compound存在统一preclean门，先于所有子配置执行", () => {
    const compound = launch.compounds.find((item) => item.name === "Chat：完整后端闭环");
    expect(compound).toBeDefined();
    // Compound级preLaunchTask在任一子调试会话启动前完成（VS Code官方语义），
    // 避免API的wait-workflow命中上一轮旧Workflow的竞态。
    expect(compound?.preLaunchTask).toBe("chat-debug:preclean");
    expect(compound?.configurations).toEqual([
      "Chat：Workflow 运行时",
      "Chat：API",
      "Chat：Web 浏览器",
    ]);
    expect(compound?.stopAll).toBe(true);
  });

  it("子配置等待链保证Workflow -> API -> Web顺序", () => {
    expect(configOf("Chat：Workflow 运行时").preLaunchTask).toBe("chat-debug:build-bundles");
    expect(configOf("Chat：API").preLaunchTask).toBe("chat-debug:wait-workflow");
    expect(configOf("Chat：Web 浏览器").preLaunchTask).toBe("chat-debug:start-web");
    const dependsOn = Object.fromEntries(
      tasks.tasks.map((task) => [task.label, task.dependsOn ?? []]),
    );
    expect(dependsOn["chat-debug:build-bundles"]).toContain("chat-debug:preclean");
    expect(dependsOn["chat-debug:start-web"]).toContain("chat-debug:wait-api");
    expect(dependsOn["chat-debug:wait-api"]).toContain("chat-debug:wait-workflow");
  });

  it("每个子配置都有postDebugTask清理", () => {
    for (const name of ["Chat：Workflow 运行时", "Chat：API", "Chat：Web 浏览器"]) {
      expect(configOf(name).postDebugTask).toBe("chat-debug:stop");
    }
  });

  it("冻结端口出现在对应配置中", () => {
    expect(configOf("Chat：API").port).toBe(43120);
    expect(configOf("Chat：API").env?.["PORT"]).toBe("43111");
    expect(configOf("Chat：Workflow 运行时").port).toBe(43121);
    expect(configOf("Chat：Workflow 运行时").env?.["CHAT_WORKFLOW_PORT"]).toBe("43112");
    expect(configOf("Chat：Web 浏览器").url).toBe("http://127.0.0.1:43110/");
  });

  it("API与Workflow调试进程都安全加载根目录.env，launch.json不含任何真实凭据", () => {
    interface EnvFileConfig {
      envFile?: string;
    }
    const api = configOf("Chat：API") as LaunchConfig & EnvFileConfig;
    const workflow = configOf("Chat：Workflow 运行时") as LaunchConfig & EnvFileConfig;
    expect(api.envFile).toBe("${workspaceFolder}/.env");
    expect(workflow.envFile).toBe("${workspaceFolder}/.env");

    // launch.json不写真实Key：不包含百炼Key变量名、Runtime凭据前缀或Bearer形态
    const raw = readFileSync(join(repoRoot, ".vscode/launch.json"), "utf8");
    expect(raw).not.toContain("DASHSCOPE_API_KEY");
    expect(raw).not.toContain("rtk_");
    expect(raw).not.toContain("Bearer ");
    // .env继续被gitignore
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.env$/m);
  });

  it(".env.example只保留变量名、安全说明与公开Base URL", () => {
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
    expect(example).toContain("DASHSCOPE_API_KEY=");
    expect(example).toContain("https://dashscope.aliyuncs.com/compatible-mode/v1");
    // 不得出现真实Key值或Runtime凭据值（变量名后不允许跟非空值）
    expect(example).not.toMatch(/^DASHSCOPE_API_KEY=\S+$/m);
    expect(example).not.toMatch(/^CHAT_RUNTIME_KEY=\S+$/m);
  });
});

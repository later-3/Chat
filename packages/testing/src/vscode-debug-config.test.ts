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
  runtimeArgs?: string[];
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
  tasks: Array<{
    label: string;
    command?: string;
    args?: string[];
    dependsOn?: string[];
    dependsOrder?: string;
  }>;
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
      "Chat：Memory（memmy）",
      "Chat：Memory（Tencent MemoryCore）",
      "Chat：Workflow 运行时",
      "Chat：API",
      "Chat：Web 浏览器",
    ]);
    expect(compound?.stopAll).toBe(true);
  });

  it("子配置等待链保证两个Memory -> Workflow -> API -> Web顺序", () => {
    expect(configOf("Chat：Memory（memmy）").preLaunchTask).toBe("chat-debug:prepare-memory");
    expect(configOf("Chat：Memory（Tencent MemoryCore）").preLaunchTask).toBe(
      "chat-debug:prepare-memorycore",
    );
    expect(configOf("Chat：Workflow 运行时").preLaunchTask).toBe("chat-debug:build-bundles");
    expect(configOf("Chat：API").preLaunchTask).toBe("chat-debug:wait-runtime-dependencies");
    expect(configOf("Chat：Web 浏览器").preLaunchTask).toBe("chat-debug:start-web");
    const taskByLabel = Object.fromEntries(tasks.tasks.map((task) => [task.label, task]));
    const dependsOn = Object.fromEntries(
      tasks.tasks.map((task) => [task.label, task.dependsOn ?? []]),
    );
    expect(dependsOn["chat-debug:prepare-memory"]).toContain("chat-debug:preclean");
    expect(taskByLabel["chat-debug:prepare-memory"]?.command).toBe("pnpm");
    expect(taskByLabel["chat-debug:prepare-memory"]?.args).toEqual(["memory:prepare:fixed"]);
    expect(taskByLabel["chat-debug:prepare-memory"]?.dependsOrder).toBe("sequence");
    expect(dependsOn["chat-debug:prepare-memorycore"]).toContain("chat-debug:preclean");
    expect(taskByLabel["chat-debug:prepare-memorycore"]?.command).toBe("pnpm");
    expect(taskByLabel["chat-debug:prepare-memorycore"]?.args).toEqual([
      "memory:prepare:memorycore-fixed",
    ]);
    expect(taskByLabel["chat-debug:prepare-memorycore"]?.dependsOrder).toBe("sequence");
    expect(dependsOn["chat-debug:build-bundles"]).toEqual([
      "chat-debug:wait-memory",
      "chat-debug:wait-memorycore",
    ]);
    expect(dependsOn["chat-debug:wait-runtime-dependencies"]).toEqual([
      "chat-debug:wait-memory",
      "chat-debug:wait-memorycore",
      "chat-debug:wait-workflow",
    ]);
    expect(dependsOn["chat-debug:start-web"]).toContain("chat-debug:wait-api");
    expect(dependsOn["chat-debug:wait-api"]).toContain("chat-debug:wait-runtime-dependencies");
  });

  it("每个子配置都有postDebugTask清理", () => {
    for (const name of [
      "Chat：Memory（memmy）",
      "Chat：Memory（Tencent MemoryCore）",
      "Chat：Workflow 运行时",
      "Chat：API",
      "Chat：Web 浏览器",
    ]) {
      expect(configOf(name).postDebugTask).toBe("chat-debug:stop");
    }
  });

  it("冻结端口出现在对应配置中", () => {
    expect(configOf("Chat：Memory（memmy）").port).toBe(43122);
    expect(configOf("Chat：Memory（memmy）").env?.["CHAT_DEBUG_PORT"]).toBe("18960");
    expect(configOf("Chat：Memory（memmy）").env?.["CHAT_MEMMY_PORT"]).toBe("18960");
    expect(configOf("Chat：Memory（memmy）").runtimeArgs).toContain(
      "scripts/memory/start-fixed-memmy.mjs",
    );
    const memoryCore = configOf("Chat：Memory（Tencent MemoryCore）");
    expect(memoryCore.port).toBe(43123);
    expect(memoryCore.env?.["CHAT_DEBUG_ROLE"]).toBe("memoryCore");
    expect(memoryCore.env?.["CHAT_DEBUG_PORT"]).toBe("18970");
    expect(memoryCore.runtimeArgs).toContain("scripts/memory/start-fixed-memorycore.mjs");
    expect(memoryCore.runtimeArgs).toContain(
      "${workspaceFolder}/scripts/debug/load-memorycore-debug-env.mjs",
    );
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
    expect(workflow.runtimeArgs).toContain(
      "${workspaceFolder}/scripts/debug/load-provider-env.mjs",
    );
    for (const config of [api, workflow, configOf("Chat：Memory（Tencent MemoryCore）")]) {
      expect(config.runtimeArgs).toContain(
        "${workspaceFolder}/scripts/debug/load-memorycore-debug-env.mjs",
      );
    }
    expect(
      workflow.runtimeArgs?.indexOf("${workspaceFolder}/scripts/debug/load-provider-env.mjs"),
    ).toBeLessThan(
      workflow.runtimeArgs?.indexOf("packages/workflows/src/runtime-main.ts") ??
        Number.POSITIVE_INFINITY,
    );

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
    expect(example).toContain("CHAT_MEMMY_BASE_URL=http://127.0.0.1:18960");
    expect(example).toContain("CHAT_TENCENT_MEMORYCORE_BASE_URL=http://127.0.0.1:18970");
    for (const name of [
      "CHAT_TENCENT_MEMORYCORE_TOKEN",
      "CHAT_TENCENT_MEMORYCORE_SERVICE_ID",
      "CHAT_TENCENT_MEMORYCORE_TEAM_ID",
      "CHAT_TENCENT_MEMORYCORE_USER_ID",
      "CHAT_TENCENT_MEMORYCORE_AGENT_ID",
      "CHAT_TENCENT_MEMORYCORE_CONFIG_REVISION",
      "CHAT_TENCENT_MEMORYCORE_CREDENTIAL_REVISION",
    ]) {
      expect(example).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(example).toContain("无需复制Key");
    // 不得出现真实Key值或Runtime凭据值（变量名后不允许跟非空值）
    expect(example).not.toMatch(/^DASHSCOPE_API_KEY=\S+$/m);
    expect(example).not.toMatch(/^CHAT_RUNTIME_KEY=\S+$/m);
    expect(example).not.toMatch(/^CHAT_TENCENT_MEMORYCORE_TOKEN=\S+$/m);
  });
});

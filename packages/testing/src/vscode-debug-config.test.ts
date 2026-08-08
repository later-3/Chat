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
  [key: string]: unknown;
  name: string;
  type?: string;
  preLaunchTask?: string;
  postDebugTask?: string;
  port?: number;
  env?: Record<string, string>;
  url?: string;
  runtimeArgs?: string[];
  program?: string;
  console?: string;
  outFiles?: string[];
  presentation?: { hidden?: boolean };
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
    type?: string;
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

function compoundVariantOf(config: LaunchConfig): Record<string, unknown> {
  const shared: Record<string, unknown> = { ...config };
  delete shared["name"];
  delete shared["preLaunchTask"];
  delete shared["presentation"];
  return shared;
}

const taskByLabel = Object.fromEntries(tasks.tasks.map((task) => [task.label, task]));

function reachableTasks(start: string): string[] {
  const visited = new Set<string>();
  const visit = (label: string) => {
    if (visited.has(label)) return;
    visited.add(label);
    for (const dependency of taskByLabel[label]?.dependsOn ?? []) visit(dependency);
  };
  visit(start);
  return [...visited];
}

describe("VS Code调试配置", () => {
  it("主Compound只通过统一准备任务执行一次preclean，先于所有子配置", () => {
    const compound = launch.compounds.find((item) => item.name === "Chat：完整后端闭环");
    expect(compound).toBeDefined();
    // Compound级preLaunchTask在任一子调试会话启动前完成（VS Code官方语义），
    // 避免API的wait-workflow命中上一轮旧Workflow的竞态。
    expect(compound?.preLaunchTask).toBe("chat-debug:prepare-compound");
    expect(compound?.configurations).toEqual([
      "Chat：Memory（memmy，Compound内部）",
      "Chat：Memory（Tencent MemoryCore，Compound内部）",
      "Chat：Workflow 运行时",
      "Chat：API",
      "Chat：Web 浏览器",
    ]);
    expect(compound?.stopAll).toBe(true);

    expect(taskByLabel["chat-debug:prepare-compound"]?.dependsOn).toEqual([
      "chat-debug:preclean",
      "chat-debug:prepare-memory-cache",
      "chat-debug:prepare-memorycore-cache",
    ]);
    expect(taskByLabel["chat-debug:prepare-compound"]?.dependsOrder).toBe("sequence");
    expect(taskByLabel["chat-debug:prepare-compound"]?.type).toBe("process");
    expect(reachableTasks("chat-debug:prepare-compound")).toContain("chat-debug:preclean");

    // Compound子配置不得再经自己的preLaunchTask触发preclean，否则两个Memory配置并发启动时，
    // 后到的preclean会误杀已经Ready的前一个服务，最终表现为前端永远无法启动。
    for (const name of compound?.configurations ?? []) {
      const preLaunchTask = configOf(name).preLaunchTask;
      if (preLaunchTask) expect(reachableTasks(preLaunchTask)).not.toContain("chat-debug:preclean");
    }
  });

  it("子配置等待链保证两个Memory -> Workflow -> API -> Web顺序", () => {
    expect(configOf("Chat：Memory（memmy）").preLaunchTask).toBe("chat-debug:prepare-memory");
    expect(configOf("Chat：Memory（Tencent MemoryCore）").preLaunchTask).toBe(
      "chat-debug:prepare-memorycore",
    );
    expect(configOf("Chat：Memory（memmy，Compound内部）").preLaunchTask).toBeUndefined();
    expect(
      configOf("Chat：Memory（Tencent MemoryCore，Compound内部）").preLaunchTask,
    ).toBeUndefined();
    expect(configOf("Chat：Memory（memmy，Compound内部）").presentation?.hidden).toBe(true);
    expect(configOf("Chat：Memory（Tencent MemoryCore，Compound内部）").presentation?.hidden).toBe(
      true,
    );
    expect(configOf("Chat：Workflow 运行时").preLaunchTask).toBe("chat-debug:build-bundles");
    expect(configOf("Chat：API").preLaunchTask).toBe("chat-debug:wait-runtime-dependencies");
    expect(configOf("Chat：Web 浏览器").preLaunchTask).toBe("chat-debug:start-web");
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
    expect(taskByLabel["chat-debug:prepare-memory-cache"]?.dependsOn).toBeUndefined();
    expect(taskByLabel["chat-debug:prepare-memorycore-cache"]?.dependsOn).toBeUndefined();
    expect(dependsOn["chat-debug:build-bundles"]).toEqual([
      "chat-debug:wait-memory",
      "chat-debug:wait-memorycore",
    ]);
    expect(dependsOn["chat-debug:wait-runtime-dependencies"]).toEqual([
      "chat-debug:wait-memory",
      "chat-debug:wait-memorycore",
      "chat-debug:wait-workflow",
    ]);
    expect(taskByLabel["chat-debug:wait-runtime-dependencies"]?.type).toBe("process");
    expect(dependsOn["chat-debug:start-web"]).toContain("chat-debug:wait-api");
    expect(dependsOn["chat-debug:wait-api"]).toContain("chat-debug:wait-runtime-dependencies");
  });

  it("每个子配置都有postDebugTask清理", () => {
    for (const name of [
      "Chat：Memory（memmy）",
      "Chat：Memory（Tencent MemoryCore）",
      "Chat：Memory（memmy，Compound内部）",
      "Chat：Memory（Tencent MemoryCore，Compound内部）",
      "Chat：Workflow 运行时",
      "Chat：API",
      "Chat：Web 浏览器",
    ]) {
      expect(configOf(name).postDebugTask).toBe("chat-debug:stop");
    }
  });

  it("Node服务由调试器直接创建进程，不经过并发集成终端shell", () => {
    for (const name of [
      "Chat：Memory（memmy）",
      "Chat：Memory（Tencent MemoryCore）",
      "Chat：Memory（memmy，Compound内部）",
      "Chat：Memory（Tencent MemoryCore，Compound内部）",
      "Chat：Workflow 运行时",
      "Chat：API",
    ]) {
      expect(configOf(name).console).toBe("internalConsole");
    }
  });

  it("隐藏Memory配置与可见单服务配置只在启动门和展示属性上不同", () => {
    expect(compoundVariantOf(configOf("Chat：Memory（memmy，Compound内部）"))).toEqual(
      compoundVariantOf(configOf("Chat：Memory（memmy）")),
    );
    expect(compoundVariantOf(configOf("Chat：Memory（Tencent MemoryCore，Compound内部）"))).toEqual(
      compoundVariantOf(configOf("Chat：Memory（Tencent MemoryCore）")),
    );
  });

  it("冻结端口出现在对应配置中", () => {
    expect(configOf("Chat：Memory（memmy）").port).toBe(43122);
    expect(configOf("Chat：Memory（memmy）").env?.["CHAT_DEBUG_PORT"]).toBe("18960");
    expect(configOf("Chat：Memory（memmy）").env?.["CHAT_MEMMY_PORT"]).toBe("18960");
    expect(configOf("Chat：Memory（memmy）").runtimeArgs).toContain(
      "${workspaceFolder}/scripts/debug/register-process.mjs",
    );
    expect(configOf("Chat：Memory（memmy）").runtimeArgs).toContain("--inspect=127.0.0.1:43122");
    expect(configOf("Chat：Memory（memmy）").program).toBe(
      "${workspaceFolder}/scripts/memory/start-fixed-memmy.mjs",
    );
    expect(configOf("Chat：Memory（memmy，Compound内部）").port).toBe(43122);
    const memoryCore = configOf("Chat：Memory（Tencent MemoryCore）");
    expect(memoryCore.port).toBe(43123);
    expect(memoryCore.env?.["CHAT_DEBUG_ROLE"]).toBe("memoryCore");
    expect(memoryCore.env?.["CHAT_DEBUG_PORT"]).toBe("18970");
    expect(memoryCore.program).toBe("${workspaceFolder}/scripts/memory/start-fixed-memorycore.mjs");
    expect(memoryCore.runtimeArgs).toContain(
      "${workspaceFolder}/scripts/debug/load-memorycore-debug-env.mjs",
    );
    expect(memoryCore.runtimeArgs).toContain("--inspect=127.0.0.1:43123");
    expect(configOf("Chat：Memory（Tencent MemoryCore，Compound内部）").port).toBe(43123);
    expect(configOf("Chat：API").port).toBe(43120);
    expect(configOf("Chat：API").env?.["PORT"]).toBe("43111");
    expect(configOf("Chat：Workflow 运行时").port).toBe(43121);
    expect(configOf("Chat：Workflow 运行时").env?.["CHAT_WORKFLOW_PORT"]).toBe("43112");
    expect(configOf("Chat：Workflow 运行时").program).toBe(
      "${workspaceFolder}/packages/workflows/src/runtime-main.ts",
    );
    expect(configOf("Chat：Workflow 运行时").outFiles).toEqual([]);
    expect(configOf("Chat：Workflow 运行时").runtimeArgs).toContain("--inspect=127.0.0.1:43121");
    expect(configOf("Chat：API").program).toBe("${workspaceFolder}/apps/api/src/index.ts");
    expect(configOf("Chat：API").outFiles).toEqual([]);
    expect(configOf("Chat：API").runtimeArgs).toContain("--inspect=127.0.0.1:43120");
    expect(configOf("Chat：Web 浏览器").url).toBe("http://127.0.0.1:43110/");
  });

  it("API与Workflow在进程内安全加载.env，VS Code终端不拼接真实凭据", () => {
    const api = configOf("Chat：API");
    const workflow = configOf("Chat：Workflow 运行时");
    expect(workflow.runtimeArgs).toContain(
      "${workspaceFolder}/scripts/debug/load-provider-env.mjs",
    );
    expect(api.runtimeArgs).toContain("${workspaceFolder}/scripts/load-env.mjs");
    for (const config of [api, workflow, configOf("Chat：Memory（Tencent MemoryCore）")]) {
      expect(config.runtimeArgs).toContain(
        "${workspaceFolder}/scripts/debug/load-memorycore-debug-env.mjs",
      );
    }
    expect(workflow.runtimeArgs?.at(-1)).toBe(
      "${workspaceFolder}/packages/workflows/node_modules/tsx/dist/loader.mjs",
    );
    expect(api.runtimeArgs?.at(-1)).toBe(
      "${workspaceFolder}/apps/api/node_modules/tsx/dist/loader.mjs",
    );
    expect(workflow.program).toBe("${workspaceFolder}/packages/workflows/src/runtime-main.ts");

    // launch.json不写真实Key：不包含百炼Key变量名、Runtime凭据前缀或Bearer形态
    const raw = readFileSync(join(repoRoot, ".vscode/launch.json"), "utf8");
    // envFile会被js-debug展开成`/usr/bin/env KEY=VALUE ...`并显示在集成终端；
    // 改为--import进程内加载后，凭据既不进argv，也不出现在终端命令行。
    expect(raw).not.toContain('"envFile"');
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

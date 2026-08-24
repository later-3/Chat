import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  DSH_PROMPT_STUDIO_E2E_PORTS,
  DSH_PROMPT_THREE_GATES_E2E_PORTS,
  DSH_PROJECT_BOOTSTRAP_E2E_PORTS,
  DSH_CAPABILITY_GOVERNANCE_E2E_PORTS,
  DSH_REAL_E2E_PORTS,
  dshRealWebEnvironment,
  dshRealWorkbenchEnvironment,
  resolveDshRealWorkbenchFixtureRoot,
  resolveDshRealWorkbenchRunRoot,
  resolveDshRealWorkbenchTempParent,
} from "./dsh-real-environment.mjs";
import { DEBUG_RUNTIME_PORTS, PRODUCTION_RUNTIME_PORTS } from "../dev/runtime-instance.mjs";

test("真实浏览器门的45xxx端口族不与production或VS Code debug重叠", () => {
  const applicationPorts = new Set([
    ...Object.values(PRODUCTION_RUNTIME_PORTS),
    ...Object.values(DEBUG_RUNTIME_PORTS),
  ]);
  for (const ports of [
    DSH_PROMPT_STUDIO_E2E_PORTS,
    DSH_PROMPT_THREE_GATES_E2E_PORTS,
    DSH_PROJECT_BOOTSTRAP_E2E_PORTS,
    DSH_CAPABILITY_GOVERNANCE_E2E_PORTS,
    DSH_REAL_E2E_PORTS,
  ]) {
    for (const port of Object.values(ports)) assert.equal(applicationPorts.has(port), false);
  }
});

test("建项浏览器门使用独立数据根且DSH Host仍拿不到Provider凭据", () => {
  const environment = dshRealWebEnvironment("/repo/chat", {
    PATH: "/bin",
    CHAT_DSH_E2E_DATA_ROOT: "/repo/chat/.data/e2e/dsh-project-bootstrap-real",
    CHAT_PUBLIC_WEB_PORT: "45410",
    CHAT_DSH_INTERNAL_WEB_PORT: "45414",
    CHAT_API_BASE_URL: "http://127.0.0.1:45411",
    DASHSCOPE_API_KEY: "provider-secret",
    PLANE_API_TOKEN: "plane-secret",
  });

  assert.equal(environment.DSH_HOME, "/repo/chat/.data/e2e/dsh-project-bootstrap-real/dsh-home");
  assert.equal(
    environment.CHAT_DSH_STATE_PATH,
    "/repo/chat/.data/e2e/dsh-project-bootstrap-real/bridge/state.json",
  );
  assert.equal(environment.CHAT_PUBLIC_WEB_PORT, "45410");
  assert.equal(environment.CHAT_DSH_INTERNAL_WEB_PORT, "45414");
  assert.equal(environment.CHAT_API_BASE_URL, "http://127.0.0.1:45411");
  assert.equal("DASHSCOPE_API_KEY" in environment, false);
  assert.equal("PLANE_API_TOKEN" in environment, false);
});

test("真实浏览器入口禁止硬编码production端口或调用production preclean", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const roots = [resolve(repoRoot, "scripts/e2e"), resolve(repoRoot, "apps/dsh-web/e2e")];
  const files = roots.flatMap((root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && /\.(?:mjs|ts)$/u.test(entry.name) && !entry.name.endsWith(".test.mjs"),
      )
      .map((entry) => resolve(entry.parentPath, entry.name)),
  );
  files.push(resolve(repoRoot, "apps/dsh-web/playwright.dsh-real.config.ts"));
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\b431(?:10|11|12|13|14|15|19|20|21|22|23)\b/u, path);
    assert.doesNotMatch(source, /debug:preclean/u, path);
  }

  const scripts = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts;
  for (const [name, command] of Object.entries(scripts)) {
    if (name.startsWith("test:e2e:")) assert.doesNotMatch(command, /debug:preclean/u, name);
  }
});

test("真实DSH子进程使用统一白名单且不继承Provider、GitHub或SSH凭据", () => {
  const environment = dshRealWebEnvironment("/repo/chat", {
    PATH: "/bin",
    LANG: "zh_CN.UTF-8",
    DASHSCOPE_API_KEY: "provider-secret",
    GITHUB_TOKEN: "github-secret",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  });

  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.LANG, "zh_CN.UTF-8");
  assert.equal(environment.DSH_HOME, "/repo/chat/.data/e2e/dsh-real/dsh-home");
  assert.equal(environment.CHAT_DSH_STATE_PATH, "/repo/chat/.data/e2e/dsh-real/bridge/state.json");
  assert.equal(environment.CHAT_PUBLIC_WEB_PORT, "45310");
  assert.equal(environment.CHAT_DSH_INTERNAL_WEB_PORT, "45314");
  assert.equal(environment.CHAT_API_BASE_URL, "http://127.0.0.1:45311");
  assert.equal("DASHSCOPE_API_KEY" in environment, false);
  assert.equal("GITHUB_TOKEN" in environment, false);
  assert.equal("SSH_AUTH_SOCK" in environment, false);
  assert.equal(environment.CHAT_CODE_WORKBENCH_TEMP_PARENT, resolveDshRealWorkbenchTempParent());
  assert.equal(environment.CHAT_FIXED_SOURCE_CACHE_ROOT, "/repo/chat/.data/cache");
});

test("三闸门付费门使用独立数据根且仍隔离Provider凭据", () => {
  const environment = dshRealWebEnvironment("/repo/chat", {
    PATH: "/bin",
    CHAT_DSH_E2E_DATA_ROOT: "/repo/chat/.data/e2e/dsh-prompt-three-gates-real",
    CHAT_DSH_E2E_TEMP_ROOT: "/repo/chat/.data/e2e/dsh-t3-tmp",
    CHAT_PUBLIC_WEB_PORT: "45210",
    CHAT_DSH_INTERNAL_WEB_PORT: "45214",
    DASHSCOPE_API_KEY: "provider-secret",
  });

  assert.equal(environment.DSH_HOME, "/repo/chat/.data/e2e/dsh-prompt-three-gates-real/dsh-home");
  assert.equal(
    environment.CHAT_DSH_E2E_DATA_ROOT,
    "/repo/chat/.data/e2e/dsh-prompt-three-gates-real",
  );
  assert.equal(
    environment.CHAT_DSH_STATE_PATH,
    "/repo/chat/.data/e2e/dsh-prompt-three-gates-real/bridge/state.json",
  );
  assert.equal(environment.CHAT_PUBLIC_WEB_PORT, "45210");
  assert.equal(environment.CHAT_DSH_INTERNAL_WEB_PORT, "45214");
  assert.equal(environment.TMPDIR, "/repo/chat/.data/e2e/dsh-t3-tmp");
  assert.equal("DASHSCOPE_API_KEY" in environment, false);
});

test("真实Workbench wrapper只接收隔离Git fixture、运行路径和基础工具链", () => {
  const environment = dshRealWorkbenchEnvironment("/repo/chat", {
    PATH: "/bin",
    HOME: "/Users/example",
    DASHSCOPE_API_KEY: "provider-secret",
    GITHUB_TOKEN: "github-secret",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
  });

  assert.equal(
    resolveDshRealWorkbenchFixtureRoot("/repo/chat"),
    "/repo/chat/.data/e2e/dsh-real/workbench-fixture",
  );
  assert.equal(
    resolveDshRealWorkbenchRunRoot("/repo/chat"),
    "/repo/chat/.data/e2e/dsh-real/workbench-fixture/.data/code-server",
  );
  assert.equal(environment.CHAT_REPO_ROOT, resolveDshRealWorkbenchFixtureRoot("/repo/chat"));
  assert.equal(environment.CHAT_CODE_WORKBENCH_ROOT, environment.CHAT_REPO_ROOT);
  assert.equal(
    environment.CHAT_CODE_WORKBENCH_RUN_ROOT,
    resolveDshRealWorkbenchRunRoot("/repo/chat"),
  );
  assert.equal(environment.CHAT_CODE_WORKBENCH_TEMP_PARENT, resolveDshRealWorkbenchTempParent());
  assert.equal(environment.CHAT_CODE_WORKBENCH_LEASE_PORT, "45319");
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.HOME, "/Users/example");
  assert.equal("DASHSCOPE_API_KEY" in environment, false);
  assert.equal("GITHUB_TOKEN" in environment, false);
  assert.equal("SSH_AUTH_SOCK" in environment, false);
});

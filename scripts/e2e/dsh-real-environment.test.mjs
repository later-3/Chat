import assert from "node:assert/strict";
import test from "node:test";

import {
  dshRealWebEnvironment,
  dshRealWorkbenchEnvironment,
  resolveDshRealWorkbenchFixtureRoot,
  resolveDshRealWorkbenchRunRoot,
  resolveDshRealWorkbenchTempParent,
} from "./dsh-real-environment.mjs";

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
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.HOME, "/Users/example");
  assert.equal("DASHSCOPE_API_KEY" in environment, false);
  assert.equal("GITHUB_TOKEN" in environment, false);
  assert.equal("SSH_AUTH_SOCK" in environment, false);
});

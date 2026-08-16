import assert from "node:assert/strict";
import test from "node:test";

import { dshRealWebEnvironment } from "./dsh-real-environment.mjs";

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
});

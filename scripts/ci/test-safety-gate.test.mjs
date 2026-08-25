import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { executeTestSafetyGate, validateTestSafetyGate } from "./test-safety-gate.mjs";
import { assertRealTestChildAuthorization } from "./real-test-child-guard.mjs";

describe("paid and external test safety gate", () => {
  it("a present API Key without paid opt-in loads no credential and starts no child", async () => {
    let loads = 0;
    let runs = 0;
    await assert.rejects(
      executeTestSafetyGate(
        {
          mode: "paid",
          commandName: "test:paid:provider:bailian",
          credentials: ["DASHSCOPE_API_KEY"],
          switches: [],
          environment: { DASHSCOPE_API_KEY: "present-but-forbidden" },
        },
        {
          loadEnvironment: async (environment) => {
            loads += 1;
            return environment;
          },
          run: () => {
            runs += 1;
            return 0;
          },
        },
      ),
      /CHAT_ALLOW_PAID_TESTS/u,
    );
    assert.equal(loads, 0);
    assert.equal(runs, 0);
  });

  it("rejects a paid command without :paid before credential loading", async () => {
    let loads = 0;
    await assert.rejects(
      validateTestSafetyGate(
        {
          mode: "paid",
          commandName: "test:provider:bailian",
          credentials: ["DASHSCOPE_API_KEY"],
          switches: [],
          environment: { CHAT_ALLOW_PAID_TESTS: "1", DASHSCOPE_API_KEY: "secret" },
        },
        async (environment) => {
          loads += 1;
          return environment;
        },
      ),
      /命令名必须包含:paid/u,
    );
    assert.equal(loads, 0);
  });

  it("requires the exact Provider credential after opt-in", async () => {
    await assert.rejects(
      validateTestSafetyGate(
        {
          mode: "paid",
          commandName: "test:paid:provider:bailian",
          credentials: ["DASHSCOPE_API_KEY"],
          switches: [],
          environment: { CHAT_ALLOW_PAID_TESTS: "1" },
        },
        async (environment) => environment,
      ),
      /DASHSCOPE_API_KEY/u,
    );
  });

  it("external writes require both the global and service-specific switches", async () => {
    const base = {
      mode: "external",
      commandName: "test:external:plane-ce",
      credentials: ["CHAT_PLANE_CE_API_TOKEN"],
      switches: ["CHAT_PLANE_CE_REAL_TEST"],
    };
    await assert.rejects(
      validateTestSafetyGate(
        {
          ...base,
          environment: {
            CHAT_PLANE_CE_REAL_TEST: "1",
            CHAT_PLANE_CE_API_TOKEN: "secret",
          },
        },
        async (environment) => environment,
      ),
      /CHAT_ALLOW_EXTERNAL_WRITES/u,
    );
    await assert.rejects(
      validateTestSafetyGate(
        {
          ...base,
          environment: {
            CHAT_ALLOW_EXTERNAL_WRITES: "1",
            CHAT_PLANE_CE_API_TOKEN: "secret",
          },
        },
        async (environment) => environment,
      ),
      /CHAT_PLANE_CE_REAL_TEST/u,
    );
  });

  it("paid child receives only the declared DashScope credential and exact command", async () => {
    const child = await validateTestSafetyGate(
      {
        mode: "paid",
        commandName: "test:paid:provider:bailian",
        credentials: ["DASHSCOPE_API_KEY"],
        switches: [],
        environment: { CHAT_ALLOW_PAID_TESTS: "1" },
      },
      async () => ({
        PATH: "/toolchain/bin",
        HOME: "/safe-home",
        TMPDIR: "/safe-tmp",
        CHAT_ALLOW_PAID_TESTS: "1",
        CHAT_ALLOW_EXTERNAL_WRITES: "1",
        CHAT_PROJECT_MODEL_API_KEY_ENV: "CUSTOM_PROVIDER_KEY",
        CUSTOM_PROVIDER_KEY: "dynamic-secret",
        DASHSCOPE_API_KEY: "dashscope-secret",
        DASHSCOPE_BASE_URL: "https://provider.invalid",
        OPENAI_API_KEY: "openai-secret",
        GEMINI_API_KEY: "gemini-secret",
        CHAT_MEMMY_TOKEN: "memory-secret",
        CHAT_PLANE_CE_API_TOKEN: "plane-secret",
        GITHUB_TOKEN: "github-secret",
        NPM_TOKEN: "npm-secret",
        SSH_AUTH_SOCK: "/ssh-agent",
      }),
    );
    assert.equal(child.PATH, "/toolchain/bin");
    assert.equal(child.HOME, "/safe-home");
    assert.equal(child.TMPDIR, "/safe-tmp");
    assert.equal(child.DASHSCOPE_API_KEY, "dashscope-secret");
    assert.equal(child.CHAT_ALLOW_PAID_TESTS, "1");
    assert.equal(child.CHAT_PAID_TEST_COMMAND_NAME, "test:paid:provider:bailian");
    for (const name of [
      "CUSTOM_PROVIDER_KEY",
      "DASHSCOPE_BASE_URL",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "CHAT_MEMMY_TOKEN",
      "CHAT_PLANE_CE_API_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "SSH_AUTH_SOCK",
      "CHAT_ALLOW_EXTERNAL_WRITES",
    ]) {
      assert.equal(child[name], "", `${name}不得进入Bailian child`);
    }
  });

  it("Memory and Plane children receive disjoint minimum sensitive environments", async () => {
    const loaded = {
      PATH: "/toolchain/bin",
      CHAT_ALLOW_EXTERNAL_WRITES: "1",
      CHAT_MEMORY_REAL_TEST: "1",
      CHAT_PLANE_CE_REAL_TEST: "1",
      CHAT_PLANE_CE_API_TOKEN: "plane-secret",
      CHAT_MEMMY_TOKEN: "memory-secret",
      CHAT_TENCENT_MEMORYCORE_TOKEN: "memorycore-secret",
      DASHSCOPE_API_KEY: "provider-secret",
      GITHUB_TOKEN: "github-secret",
      SSH_AUTH_SOCK: "/ssh-agent",
    };
    const memory = await validateTestSafetyGate(
      {
        mode: "external",
        commandName: "test:external:memory:memmy",
        credentials: [],
        switches: ["CHAT_MEMORY_REAL_TEST"],
        environment: loaded,
      },
      async () => loaded,
    );
    assert.equal(memory.CHAT_ALLOW_EXTERNAL_WRITES, "1");
    assert.equal(memory.CHAT_MEMORY_REAL_TEST, "1");
    assert.equal(memory.CHAT_EXTERNAL_TEST_COMMAND_NAME, "test:external:memory:memmy");
    for (const name of [
      "CHAT_PLANE_CE_REAL_TEST",
      "CHAT_PLANE_CE_API_TOKEN",
      "CHAT_MEMMY_TOKEN",
      "CHAT_TENCENT_MEMORYCORE_TOKEN",
      "DASHSCOPE_API_KEY",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
    ]) {
      assert.equal(memory[name], "", `${name}不得进入Memory child`);
    }

    const plane = await validateTestSafetyGate(
      {
        mode: "external",
        commandName: "test:external:plane-ce",
        credentials: ["CHAT_PLANE_CE_API_TOKEN"],
        switches: ["CHAT_PLANE_CE_REAL_TEST"],
        environment: loaded,
      },
      async () => loaded,
    );
    assert.equal(plane.CHAT_PLANE_CE_API_TOKEN, "plane-secret");
    assert.equal(plane.CHAT_PLANE_CE_REAL_TEST, "1");
    for (const name of [
      "CHAT_MEMORY_REAL_TEST",
      "CHAT_MEMMY_TOKEN",
      "CHAT_TENCENT_MEMORYCORE_TOKEN",
      "DASHSCOPE_API_KEY",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
    ]) {
      assert.equal(plane[name], "", `${name}不得进入Plane child`);
    }
  });

  it("child-side guard requires exact command before every real entrypoint side effect", () => {
    assert.throws(
      () =>
        assertRealTestChildAuthorization(
          {
            mode: "paid",
            commandName: "test:paid:provider:bailian",
            credentials: ["DASHSCOPE_API_KEY"],
          },
          {
            CHAT_ALLOW_PAID_TESTS: "1",
            CHAT_PAID_TEST_COMMAND_NAME: "test:paid:provider:bailian:note",
            DASHSCOPE_API_KEY: "present",
          },
        ),
      /精确受管命令/u,
    );
    assert.throws(
      () =>
        assertRealTestChildAuthorization(
          {
            mode: "external",
            commandName: "test:external:memory:memmy",
            serviceSwitch: "CHAT_MEMORY_REAL_TEST",
            credentials: [],
          },
          {
            CHAT_ALLOW_EXTERNAL_WRITES: "1",
            CHAT_EXTERNAL_TEST_COMMAND_NAME: "test:external:memory:memmy",
          },
        ),
      /CHAT_MEMORY_REAL_TEST/u,
    );

    const entries = [
      ["scripts/memory/verify-fixed-memmy-http.ts", "const repoRoot"],
      ["scripts/memory/verify-fixed-memorycore-http.ts", "const TOKEN"],
      ["scripts/memory/verify-response-drop.ts", "const repoRoot"],
      ["packages/pi-runtime/src/provider-bailian.real.ts", "loadBailianConfig(process.env)"],
      ["packages/pi-runtime/src/provider-bailian-coding.real.ts", "let root"],
      ["packages/pi-runtime/src/provider-bailian-note.real.ts", "loadBailianConfig(process.env)"],
    ];
    const root = resolve(import.meta.dirname, "../..");
    for (const [path, firstSideEffect] of entries) {
      const source = readFileSync(resolve(root, path), "utf8");
      const guard = source.indexOf("assertRealTestChildAuthorization({");
      assert.ok(guard >= 0, `${path}缺少child-side guard`);
      assert.ok(guard < source.indexOf(firstSideEffect), `${path}在授权前触达真实测试入口`);
      assert.doesNotMatch(source.slice(0, guard), /load-env\.mjs/u, `${path}在授权前加载.env`);
    }
  });
});

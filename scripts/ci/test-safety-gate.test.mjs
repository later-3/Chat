import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      commandName: "test:external:memory:memmy",
      credentials: [],
      switches: ["CHAT_MEMORY_REAL_TEST"],
    };
    await assert.rejects(
      validateTestSafetyGate(
        {
          ...base,
          environment: {
            CHAT_MEMORY_REAL_TEST: "1",
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
          },
        },
        async (environment) => environment,
      ),
      /CHAT_MEMORY_REAL_TEST/u,
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
        GITHUB_TOKEN: "github-secret",
        NPM_TOKEN: "npm-secret",
        SSH_AUTH_SOCK: "/ssh-agent",
        CHAT_RUNTIME_KEY: "runtime-secret",
        CHAT_RUNTIME_CREDENTIAL_PATH: "/credential-path",
        CHAT_WEB_AUTH_CREDENTIALS_FILE: "/web-auth",
        CHAT_TEST_EXECUTOR_SECRET: "executor-secret",
        CHAT_CAPABILITY_E2E_CONTROL_TOKEN: "control-token",
        FUTURE_UNKNOWN_SECRET: "future-secret",
        UNDECLARED_NON_SENSITIVE_CONFIG: "must-not-be-copied",
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
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "SSH_AUTH_SOCK",
      "CHAT_ALLOW_EXTERNAL_WRITES",
      "CHAT_RUNTIME_KEY",
      "CHAT_RUNTIME_CREDENTIAL_PATH",
      "CHAT_WEB_AUTH_CREDENTIALS_FILE",
      "CHAT_TEST_EXECUTOR_SECRET",
      "CHAT_CAPABILITY_E2E_CONTROL_TOKEN",
      "FUTURE_UNKNOWN_SECRET",
    ]) {
      assert.equal(child[name], "", `${name}不得进入Bailian child`);
    }
    assert.equal(child.UNDECLARED_NON_SENSITIVE_CONFIG, undefined);
  });

  it("Memory child receives only its declared minimum sensitive environment", async () => {
    const loaded = {
      PATH: "/toolchain/bin",
      CHAT_ALLOW_EXTERNAL_WRITES: "1",
      CHAT_MEMORY_REAL_TEST: "1",
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
      "CHAT_MEMMY_TOKEN",
      "CHAT_TENCENT_MEMORYCORE_TOKEN",
      "DASHSCOPE_API_KEY",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
    ]) {
      assert.equal(memory[name], "", `${name}不得进入Memory child`);
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

  it("three paid Provider configs each collect exactly their own real entry without calling Provider", () => {
    const root = resolve(import.meta.dirname, "../..");
    const packageRoot = resolve(root, "packages/pi-runtime");
    const cases = [
      ["test:paid:provider:bailian", "vitest.provider.config.ts", "provider-bailian.real.ts"],
      [
        "test:paid:provider:bailian:coding",
        "vitest.provider-coding.config.ts",
        "provider-bailian-coding.real.ts",
      ],
      [
        "test:paid:provider:bailian:note",
        "vitest.provider-note.config.ts",
        "provider-bailian-note.real.ts",
      ],
    ];
    for (const [commandName, config, expected] of cases) {
      const result = spawnSync("pnpm", ["exec", "vitest", "list", "--json", "--config", config], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG,
          CI: "true",
          CHAT_ALLOW_PAID_TESTS: "1",
          CHAT_PAID_TEST_COMMAND_NAME: commandName,
          DASHSCOPE_API_KEY: "collection-sentinel-not-a-real-key",
        },
      });
      assert.equal(result.status, 0, `${config}: ${result.stderr}`);
      const files = [...new Set(JSON.parse(result.stdout).map((entry) => entry.file))].filter(
        (file) => file.endsWith(".real.ts"),
      );
      assert.equal(files.length, 1, `${config}必须精确收集一个real入口`);
      assert.ok(files[0].endsWith(expected), `${config}收集了错误入口：${files[0]}`);

      const wrong = spawnSync("pnpm", ["exec", "vitest", "list", "--json", "--config", config], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG,
          CI: "true",
          CHAT_ALLOW_PAID_TESTS: "1",
          CHAT_PAID_TEST_COMMAND_NAME: `${commandName}:wrong`,
        },
      });
      assert.notEqual(wrong.status, 0);
      assert.match(`${wrong.stdout}\n${wrong.stderr}`, /精确受管命令/u);
      assert.doesNotMatch(`${wrong.stdout}\n${wrong.stderr}`, /缺少精确测试凭据/u);
    }

    const ordinary = spawnSync("pnpm", ["exec", "vitest", "list", "--filesOnly"], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        CI: "true",
      },
    });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.doesNotMatch(ordinary.stdout, /\.real\.ts/u);

    const rootManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const piManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    for (const [commandName, config] of cases) {
      assert.ok(rootManifest.scripts[commandName].includes(commandName));
      assert.ok(piManifest.scripts[commandName].includes(config));
    }
  });
});

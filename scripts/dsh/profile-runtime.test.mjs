import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertBridgeBundleContract,
  assertDshDistribution,
  assertDshWebCutoverConfig,
  assertManagedWebProfileReady,
  dshBridgeInstallArgs,
  dshWebArgs,
  dshWebEnvironment,
  installDshWebEnvironment,
  resolveDshBin,
  resolveDshWebRuntime,
} from "./profile-runtime.mjs";

const ROOT = "/workspace/chat-feature";

test("DSH_HOME固定在当前worktree且Bridge私有状态不进入启动参数", () => {
  const runtime = resolveDshWebRuntime(ROOT, {
    DSH_HOME: "/Users/example/.dsh",
    CHAT_DSH_STATE_PATH: "/private/chat-state.json",
  });
  assert.equal(runtime.dshHome, "/workspace/chat-feature/.data/dsh-home");
  assert.equal(runtime.statePath, "/private/chat-state.json");
  assert.deepEqual(dshWebArgs(runtime), ["web", "--host", "127.0.0.1", "--port", "43110"]);
  assert.deepEqual(dshBridgeInstallArgs(runtime), [
    "plugin",
    "--profile",
    "web",
    "add",
    "--save-exact",
    "link:/workspace/chat-feature/packages/dsh-lifeos-bridge",
  ]);
  assert.doesNotMatch(dshWebArgs(runtime).join(" "), /chat-state|43111/u);
});

test("DSH进程显式接收Chat API与Bridge状态且剥离VS Code自动附加", () => {
  const environment = dshWebEnvironment(ROOT, {
    CHAT_API_BASE_URL: "http://127.0.0.1:43111/",
    NODE_OPTIONS: "--require /vscode/bootloader.js",
    VSCODE_INSPECTOR_OPTIONS: "secret-attach-options",
    DSH_TELEMETRY_MODE: "FULL",
    DSH_TELEMETRY_OTLP_URL: "https://collector.example/v1/logs",
    DSH_TELEMETRY_FUTURE_OVERRIDE: "polluted",
    DASHSCOPE_API_KEY: "provider-secret",
    AWS_SECRET_ACCESS_KEY: "cloud-secret",
    GITHUB_TOKEN: "source-secret",
    HOME: "/Users/example",
    PATH: "/usr/bin:/bin",
  });
  assert.equal(environment.CHAT_API_BASE_URL, "http://127.0.0.1:43111");
  assert.equal(
    environment.CHAT_DSH_STATE_PATH,
    "/workspace/chat-feature/.data/dsh-lifeos-bridge/state.json",
  );
  assert.equal(environment.DSH_HOME, "/workspace/chat-feature/.data/dsh-home");
  assert.equal(environment.DSH_WEB_PORT, "43110");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.VSCODE_INSPECTOR_OPTIONS, undefined);
  assert.equal(environment.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(environment.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(environment.DSH_TELEMETRY_OTLP_URL, undefined);
  assert.equal(environment.DSH_TELEMETRY_FUTURE_OVERRIDE, undefined);
  assert.equal(environment.DASHSCOPE_API_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.PATH, "/usr/bin:/bin");
  assert.equal(environment.HOME, "/Users/example");
  const installed = {
    PATH: "/old/path",
    DASHSCOPE_API_KEY: "must-disappear",
    SSH_AUTH_SOCK: "/private/agent.sock",
  };
  installDshWebEnvironment(installed, environment);
  assert.deepEqual(installed, environment);
  assert.throws(
    () =>
      dshWebEnvironment(ROOT, {
        CHAT_API_BASE_URL: "http://user:password@127.0.0.1:43111",
      }),
    /不能在URL中携带凭据/u,
  );
});

test("Bridge原生bundle patch不包含API与私有状态路径", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-dsh-profile-"));
  try {
    const runtime = resolveDshWebRuntime(root);
    mkdirSync(runtime.bridgePackageDir, { recursive: true });
    writeFileSync(
      join(runtime.bridgePackageDir, "package.json"),
      `${JSON.stringify({
        name: "@chat/dsh-lifeos-bridge",
        main: "dist/dsh-bundle.js",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      })}\n`,
    );
    writeFileSync(
      join(runtime.bridgePackageDir, "cordis.patch.yml"),
      "- insert:\n    - id: lifeos-bridge\n      name: '@chat/dsh-lifeos-bridge'\n",
    );
    assert.deepEqual(assertBridgeBundleContract(runtime), {
      bundlePath: runtime.bridgeBundlePath,
      patchPath: join(runtime.bridgePackageDir, "cordis.patch.yml"),
    });
    assert.doesNotMatch(
      readFileSync(join(runtime.bridgePackageDir, "cordis.patch.yml"), "utf8"),
      /CHAT_API_BASE_URL|CHAT_DSH_STATE_PATH|43111|state\.json/u,
    );
    assert.throws(() => assertManagedWebProfileReady(runtime), /尚未准备/u);
    mkdirSync(join(runtime.profileDir, "node_modules/@chat/dsh-lifeos-bridge"), {
      recursive: true,
    });
    writeFileSync(
      join(runtime.profileDir, "package.json"),
      `${JSON.stringify({
        dependencies: {
          "@chat/dsh-lifeos-bridge": "link:../../../../../packages/dsh-lifeos-bridge",
        },
        dsh: { profile: { bundles: ["@chat/dsh-lifeos-bridge"] } },
      })}\n`,
    );
    writeFileSync(join(runtime.profileDir, "cordis.patch.yml"), "[]\n");
    writeFileSync(
      join(runtime.profileDir, "node_modules/@chat/dsh-lifeos-bridge/package.json"),
      "{}\n",
    );
    mkdirSync(join(runtime.bridgeBundlePath, ".."), { recursive: true });
    writeFileSync(runtime.bridgeBundlePath, "");
    assert.doesNotThrow(() => assertManagedWebProfileReady(runtime));
    const validDump = [
      "- id: agent-default-model",
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      "  config:",
      "    provider: lifeos",
      "    model: workflow",
      "- id: llm-deepseek",
      "  disabled: true",
      "- id: llm-pi-ai",
      "  disabled: true",
      "- id: lifeos-bridge",
      "  name: '@chat/dsh-lifeos-bridge'",
      "- id: webserver",
      "",
    ].join("\n");
    assert.doesNotThrow(() => assertDshWebCutoverConfig(validDump));
    assert.throws(
      () =>
        assertDshWebCutoverConfig(
          `${validDump}- id: lifeos-bridge\n  name: '@chat/dsh-lifeos-bridge'\n`,
        ),
      /实际为2/u,
    );
    assert.throws(
      () => assertDshWebCutoverConfig(validDump.replace("provider: lifeos", "provider: deepseek")),
      /默认Provider必须是lifeos/u,
    );
    assert.throws(
      () => assertDshWebCutoverConfig(validDump.replace("model: workflow", "model: direct")),
      /默认Model必须是workflow/u,
    );
    assert.throws(
      () => assertDshWebCutoverConfig(validDump.replace("disabled: true", "disabled: false")),
      /llm-deepseek必须disabled/u,
    );
    assert.throws(
      () =>
        assertDshWebCutoverConfig(
          validDump.replace(
            "- id: llm-pi-ai\n  disabled: true",
            "- id: llm-pi-ai\n  disabled: false",
          ),
        ),
      /llm-pi-ai必须disabled/u,
    );

    writeFileSync(
      join(runtime.profileDir, "package.json"),
      `${JSON.stringify({
        dependencies: {
          "@chat/dsh-lifeos-bridge": "link:../../../../../packages/dsh-lifeos-bridge",
        },
        dsh: {
          profile: {
            bundles: ["@chat/dsh-lifeos-bridge", "@chat/dsh-lifeos-bridge"],
          },
        },
      })}\n`,
    );
    assert.throws(() => assertManagedWebProfileReady(runtime), /实际为2/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH入口只接受精确rc.6并从bin声明解析", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-dsh-bin-"));
  try {
    const packageDir = join(root, "apps/dsh-web/node_modules/@deepseek-ai/dsh");
    mkdirSync(join(packageDir, "lib"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ version: "0.1.0-rc.6", bin: { dsh: "lib/bin.js" } })}\n`,
    );
    writeFileSync(join(packageDir, "lib/bin.js"), "");
    assert.equal(resolveDshBin(root), join(packageDir, "lib/bin.js"));

    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ version: "0.1.0-rc.7", bin: { dsh: "lib/bin.js" } })}\n`,
    );
    assert.throws(() => resolveDshBin(root), /版本必须是0\.1\.0-rc\.6/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Distribution build校验固定DSH与Bridge产物但不创建运行profile", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-dsh-distribution-"));
  try {
    const dshDir = join(root, "apps/dsh-web/node_modules/@deepseek-ai/dsh");
    mkdirSync(join(dshDir, "lib"), { recursive: true });
    writeFileSync(
      join(dshDir, "package.json"),
      `${JSON.stringify({ version: "0.1.0-rc.6", bin: { dsh: "lib/bin.js" } })}\n`,
    );
    writeFileSync(join(dshDir, "lib/bin.js"), "");
    const runtime = resolveDshWebRuntime(root);
    mkdirSync(runtime.bridgePackageDir, { recursive: true });
    writeFileSync(
      join(runtime.bridgePackageDir, "package.json"),
      `${JSON.stringify({
        name: "@chat/dsh-lifeos-bridge",
        main: "dist/dsh-bundle.js",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      })}\n`,
    );
    writeFileSync(join(runtime.bridgePackageDir, "cordis.patch.yml"), "[]\n");
    mkdirSync(join(runtime.bridgeBundlePath, ".."), { recursive: true });
    writeFileSync(runtime.bridgeBundlePath, "");

    assert.deepEqual(assertDshDistribution(root), {
      dshBin: join(dshDir, "lib/bin.js"),
      bridgeBundlePath: runtime.bridgeBundlePath,
    });
    assert.equal(existsSync(join(root, ".data")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

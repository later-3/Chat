import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXED_BETTER_SQLITE3_ASSETS,
  FIXED_MEMMY_COMMIT,
  FIXED_MEMMY_EVIDENCE_FILE,
  FIXED_MEMMY_LOCAL_MIRROR_ENV,
  FIXED_MEMMY_NODE_ABI,
  FIXED_MEMMY_SOURCE_URL,
  FIXED_MEMMY_TREE,
  archiveFixedGitSource,
  assertChatDataPath,
  createSafeChildProcessEnvironment,
  fixedBetterSqlite3Asset,
  fixedMemmyCacheRoot,
  installFixedBetterSqlite3Prebuild,
  runtimeDependencyArtifactSha256,
  runtimeArtifactSha256,
  sourceManifestSha256,
  validateFixedMemmyCache,
} from "./fixed-memmy.mjs";
import {
  FIXED_MEMORYCORE_COMMIT,
  FIXED_MEMORYCORE_LOCAL_MIRROR_ENV,
  FIXED_MEMORYCORE_LOCK_PATH,
  FIXED_MEMORYCORE_LOCK_SHA256,
  FIXED_MEMORYCORE_SOURCE_URL,
  assertFixedMemoryCoreLockArtifact,
  fixedMemoryCoreCacheRoot,
} from "./fixed-memorycore.mjs";

const root = "/tmp/chat-fixed-memmy-contract";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function waitForOutput(child, expected) {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("dummy listener did not become ready")),
      3_000,
    );
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes(expected)) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`dummy listener exited early: ${String(code)}`));
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

describe("fixed memmy script contracts", () => {
  it("cache path is commit-addressed under Chat .data", () => {
    assert.equal(
      fixedMemmyCacheRoot(root),
      resolve(root, ".data/cache/memmy-agent", FIXED_MEMMY_COMMIT),
    );
    const sharedEnvironment = { CHAT_FIXED_SOURCE_CACHE_ROOT: "/tmp/chat-shared-cache" };
    assert.equal(
      fixedMemmyCacheRoot(root, sharedEnvironment),
      resolve("/tmp/chat-shared-cache/memmy-agent", FIXED_MEMMY_COMMIT),
    );
    assert.equal(
      fixedMemoryCoreCacheRoot(root, sharedEnvironment),
      resolve("/tmp/chat-shared-cache/tencent-memorycore", FIXED_MEMORYCORE_COMMIT),
    );
  });

  it("accepts only a dedicated .data child path", () => {
    assert.equal(
      assertChatDataPath(resolve(root, ".data/e2e/run"), root),
      resolve(root, ".data/e2e/run"),
    );
    assert.throws(() => assertChatDataPath(resolve(root, ".data"), root));
    assert.throws(() => assertChatDataPath(resolve(root, "outside"), root));
  });

  it("an actual child receives only the safe allowlist and isolated npm config", () => {
    const isolationRoot = mkdtempSync(resolve(tmpdir(), "chat-fixed-memmy-child-env-"));
    try {
      const environment = createSafeChildProcessEnvironment(
        isolationRoot,
        { MEMMY_APP_ENV: "test" },
        {
          ...process.env,
          DASHSCOPE_API_KEY: "sentinel-dashscope",
          CHAT_RUNTIME_KEY: "sentinel-runtime",
          CHAT_MEMMY_TOKEN: "sentinel-memory",
          ARBITRARY_SECRET: "sentinel-secret",
          DATABASE_PASSWORD: "sentinel-password",
          CHAT_PROVIDER: "sentinel-provider",
        },
      );
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `const forbidden=/(?:TOKEN|API_?KEY|SECRET|PASSWORD|CREDENTIAL|PROVIDER|(?:^|_)KEY(?:_|$)|AUTH)/u;
           if(Object.keys(process.env).some((name)=>forbidden.test(name.toUpperCase()))) process.exit(42);
           process.stdout.write("SAFE");`,
        ],
        { env: environment, encoding: "utf8" },
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "SAFE");
      assert.equal(environment.MEMMY_APP_ENV, "test");
      assert.equal(environment.HOME, resolve(isolationRoot, "home"));
      assert.equal(environment.NPM_CONFIG_AUDIT, "false");
      assert.equal(readFileSync(environment.NPM_CONFIG_USERCONFIG, "utf8"), "");
      assert.equal(readFileSync(environment.NPM_CONFIG_GLOBALCONFIG, "utf8"), "");
    } finally {
      rmSync(isolationRoot, { recursive: true, force: true });
    }
  });

  it("archives only a verified fixed Git object from an explicit local mirror", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "chat-fixed-git-source-"));
    const source = resolve(fixture, "source");
    const target = resolve(fixture, "archive");
    const environmentRoot = resolve(fixture, "environment");
    try {
      mkdirSync(source);
      mkdirSync(target);
      git(source, ["init", "--quiet"]);
      writeFileSync(resolve(source, "fixed.txt"), "fixed object\n");
      git(source, ["add", "fixed.txt"]);
      git(source, [
        "-c",
        "user.name=Chat Test",
        "-c",
        "user.email=chat-test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixed",
      ]);
      const commit = git(source, ["rev-parse", "HEAD"]);
      const tree = git(source, ["rev-parse", "HEAD^{tree}"]);
      const environment = createSafeChildProcessEnvironment(environmentRoot, {
        GIT_TERMINAL_PROMPT: "0",
      });
      const result = archiveFixedGitSource({
        target,
        repoRoot: fixture,
        sourceName: "fixture",
        sourceUrl: "https://example.invalid/fixed.git",
        localMirrorEnv: "CHAT_TEST_FIXED_SOURCE_REPO",
        commit,
        tree,
        environment,
        hostEnvironment: { CHAT_TEST_FIXED_SOURCE_REPO: source },
      });
      assert.equal(result.mode, "explicit-local-mirror");
      assert.equal(readFileSync(resolve(target, "fixed.txt"), "utf8"), "fixed object\n");
      assert.throws(
        () =>
          archiveFixedGitSource({
            target,
            repoRoot: fixture,
            sourceName: "fixture",
            sourceUrl: "https://example.invalid/fixed.git",
            localMirrorEnv: "CHAT_TEST_FIXED_SOURCE_REPO",
            commit,
            tree: "0".repeat(40),
            environment,
            hostEnvironment: { CHAT_TEST_FIXED_SOURCE_REPO: source },
          }),
        /Git object/u,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("uses portable HTTPS sources and explicit opt-in local mirror variables", () => {
    assert.equal(new URL(FIXED_MEMMY_SOURCE_URL).protocol, "https:");
    assert.equal(new URL(FIXED_MEMORYCORE_SOURCE_URL).protocol, "https:");
    assert.equal(FIXED_MEMMY_LOCAL_MIRROR_ENV, "CHAT_MEMMY_SOURCE_REPO");
    assert.equal(FIXED_MEMORYCORE_LOCAL_MIRROR_ENV, "CHAT_TENCENT_MEMORYCORE_SOURCE_REPO");
    for (const file of ["fixed-memmy.mjs", "fixed-memorycore.mjs"]) {
      const source = readFileSync(resolve(repoRoot, "scripts/memory", file), "utf8");
      assert.doesNotMatch(source, /\/Users\/xulater/u);
      assert.doesNotMatch(source, /symlinkSync/u);
    }
  });

  it("pins the Node 24 better-sqlite3 asset matrix and rejects unsupported runtimes", () => {
    const expected = {
      "darwin-arm64": "b140983c8befcef30532ea615aa106c770f2f95cd20994d31ca593c0b4e85423",
      "darwin-x64": "a02f8e9c2024f2bd4386e58671524fcf722c5187b549f46a955d8e9c3b22f733",
      "linux-arm64": "7648f3a8295cf03a036eb392b66fbef75347662d654f6ab558f5f33c9e47d69a",
      "linux-x64": "c2f7503e6cc3a2b1dc9fd03e7194934438f42e0724ecac6696da0582585362f2",
    };
    assert.equal(FIXED_MEMMY_NODE_ABI, "137");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(FIXED_BETTER_SQLITE3_ASSETS).map(([key, value]) => [key, value.sha256]),
      ),
      expected,
    );
    for (const key of Object.keys(expected)) {
      const [platform, arch] = key.split("-");
      const asset = fixedBetterSqlite3Asset(
        platform,
        arch,
        FIXED_MEMMY_NODE_ABI,
        platform === "linux" ? "glibc-2.29" : "n/a",
      );
      assert.equal(asset.sha256, expected[key]);
      assert.match(asset.url, /^https:\/\/github\.com\/WiseLibs\/better-sqlite3\/releases\//u);
    }
    assert.throws(() => fixedBetterSqlite3Asset("darwin", "arm64", "127", "n/a"), /ABI 137/u);
    assert.throws(
      () => fixedBetterSqlite3Asset("linux", "x64", "137", "glibc-2.28"),
      /glibc>=2\.29/u,
    );
    assert.throws(
      () => fixedBetterSqlite3Asset("linux", "x64", "137", "musl-or-unknown"),
      /glibc>=2\.29/u,
    );
  });

  it("rejects a changed better-sqlite3 download before extraction", async () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "chat-better-sqlite-download-"));
    const packageRoot = resolve(fixture, "node_modules/better-sqlite3");
    const environmentRoot = resolve(fixture, "environment");
    try {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(resolve(packageRoot, "package.json"), '{"name":"better-sqlite3"}\n');
      const environment = createSafeChildProcessEnvironment(environmentRoot);
      await assert.rejects(
        installFixedBetterSqlite3Prebuild(fixture, environment, {
          fetchImpl: async () => new Response("tampered"),
          platform: "darwin",
          arch: "arm64",
          nodeAbi: "137",
        }),
        /大小漂移/u,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("pins and audits the Chat-owned MemoryCore npm lock artifact", () => {
    const lock = assertFixedMemoryCoreLockArtifact();
    assert.equal(Object.keys(lock.packages).length > 600, true);
    assert.match(FIXED_MEMORYCORE_LOCK_SHA256, /^[0-9a-f]{64}$/u);

    const fixture = mkdtempSync(resolve(tmpdir(), "chat-memorycore-lock-"));
    const tampered = resolve(fixture, "package-lock.json");
    try {
      copyFileSync(FIXED_MEMORYCORE_LOCK_PATH, tampered);
      writeFileSync(tampered, `${readFileSync(tampered, "utf8")}\n`);
      assert.throws(() => assertFixedMemoryCoreLockArtifact(tampered), /SHA-256/u);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("installs MemoryCore only from the audited lock without lifecycle scripts", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/memory/fixed-memorycore.mjs"), "utf8");
    assert.match(source, /\["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps"\]/u);
    assert.match(source, /copyFileSync\(FIXED_MEMORYCORE_LOCK_PATH/u);
    assert.doesNotMatch(source, /node_modules.*symlink/u);
  });

  it("the fixed server uses the same safe environment instead of spreading process.env", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/memory/start-fixed-memmy.mjs"), "utf8");
    assert.match(source, /env: createSafeChildProcessEnvironment\(/u);
    assert.doesNotMatch(source, /\.\.\.process\.env/u);

    const memoryCoreSource = readFileSync(
      resolve(repoRoot, "scripts/memory/start-fixed-memorycore.mjs"),
      "utf8",
    );
    assert.match(memoryCoreSource, /env: createSafeChildProcessEnvironment\(/u);
    assert.match(memoryCoreSource, /LOG_PATH: disabledProviderLogPath/u);
    assert.match(memoryCoreSource, /provider-file-logging-disabled/u);
    assert.doesNotMatch(memoryCoreSource, /\.\.\.process\.env/u);
  });

  it("installs memmy without third-party lifecycle scripts or optional CUDA downloads", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/memory/fixed-memmy.mjs"), "utf8");
    assert.match(source, /"ci",\s*"--ignore-scripts",\s*"--workspace"/u);
    assert.match(source, /ONNXRUNTIME_NODE_INSTALL_CUDA: "skip"/u);
    assert.match(source, /installFixedBetterSqlite3Prebuild/u);
    assert.doesNotMatch(source, /prebuild-install.*spawn|npm rebuild/u);
  });

  it("rejects legacy cache evidence and a changed native binary", () => {
    const fakeRepo = mkdtempSync(resolve(tmpdir(), "chat-fixed-memmy-evidence-"));
    try {
      const cache = fixedMemmyCacheRoot(fakeRepo);
      const serverEntry = resolve(cache, "Memory/dist/src/server/index.js");
      mkdirSync(dirname(serverEntry), { recursive: true });
      writeFileSync(resolve(cache, "README.md"), "fixed archive source\n");
      writeFileSync(serverEntry, "export const runtime = 'fixed';\n");
      writeFileSync(
        resolve(cache, FIXED_MEMMY_EVIDENCE_FILE),
        `${JSON.stringify({
          schemaVersion: "chat-fixed-memmy-source.v1",
          commit: FIXED_MEMMY_COMMIT,
          tree: FIXED_MEMMY_TREE,
          sourceManifestSha256: sourceManifestSha256(cache),
          runtimeArtifactSha256: runtimeArtifactSha256(cache),
        })}\n`,
      );
      assert.equal(validateFixedMemmyCache(fakeRepo), false);
      const evidenceBefore = readFileSync(resolve(cache, FIXED_MEMMY_EVIDENCE_FILE), "utf8");
      writeFileSync(serverEntry, "export const runtime = 'tampered';\n");
      assert.equal(validateFixedMemmyCache(fakeRepo), false);
      assert.equal(readFileSync(resolve(cache, FIXED_MEMMY_EVIDENCE_FILE), "utf8"), evidenceBefore);

      const binaryPath = resolve(cache, "node_modules/better-sqlite3/build/Release");
      mkdirSync(binaryPath, { recursive: true });
      writeFileSync(resolve(binaryPath, "better_sqlite3.node"), "tampered native binary");
      assert.throws(() => runtimeDependencyArtifactSha256(cache), /SHA-256/u);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  it("refuses an unknown 18960 listener and leaves it alive", async () => {
    const dummy = spawn(
      process.execPath,
      [
        "-e",
        'const s=require("node:http").createServer(); s.listen(18960,"127.0.0.1",()=>console.log("READY")); process.on("SIGTERM",()=>s.close());',
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await waitForOutput(dummy, "READY");
      const result = spawnSync(
        process.execPath,
        [resolve(repoRoot, "scripts/memory/start-fixed-memmy.mjs")],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            CHAT_REPO_ROOT: repoRoot,
            CHAT_MEMMY_RUN_ROOT: resolve(repoRoot, ".data/tests/fixed-memmy-port-contract"),
          },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /未知进程占用/u);
      assert.doesNotThrow(() => process.kill(dummy.pid, 0));
    } finally {
      if (dummy.exitCode === null && dummy.signalCode === null) dummy.kill("SIGTERM");
      await waitForExit(dummy);
    }
  });

  it("pins both Memory wrappers to the selected runtime-instance port", () => {
    const memmy = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/memory/start-fixed-memmy.mjs")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CHAT_REPO_ROOT: repoRoot,
          CHAT_RUNTIME_INSTANCE: "debug",
          CHAT_MEMMY_PORT: "18960",
          CHAT_MEMMY_RUN_ROOT: resolve(repoRoot, ".data/tests/fixed-memmy-debug-port"),
        },
      },
    );
    assert.equal(memmy.status, 1);
    assert.match(memmy.stderr, /debug实例.*19960/u);

    const memoryCore = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/memory/start-fixed-memorycore.mjs")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CHAT_REPO_ROOT: repoRoot,
          CHAT_RUNTIME_INSTANCE: "debug",
          CHAT_TENCENT_MEMORYCORE_PORT: "18970",
          CHAT_TENCENT_MEMORYCORE_TOKEN: "local-test-token",
          CHAT_TENCENT_MEMORYCORE_RUN_ROOT: resolve(
            repoRoot,
            ".data/tests/fixed-memorycore-debug-port",
          ),
        },
      },
    );
    assert.equal(memoryCore.status, 1);
    assert.match(memoryCore.stderr, /debug实例.*19970/u);
  });
});

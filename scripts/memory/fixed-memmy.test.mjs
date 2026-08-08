import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXED_MEMMY_COMMIT,
  FIXED_MEMMY_EVIDENCE_FILE,
  FIXED_MEMMY_TREE,
  assertChatDataPath,
  createSafeChildProcessEnvironment,
  fixedMemmyCacheRoot,
  runtimeArtifactSha256,
  sourceManifestSha256,
  validateFixedMemmyCache,
} from "./fixed-memmy.mjs";

const root = "/tmp/chat-fixed-memmy-contract";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

describe("fixed memmy script contracts", () => {
  it("cache path is commit-addressed under Chat .data", () => {
    assert.equal(
      fixedMemmyCacheRoot(root),
      resolve(root, ".data/cache/memmy-agent", FIXED_MEMMY_COMMIT),
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
      assert.equal(readFileSync(environment.NPM_CONFIG_USERCONFIG, "utf8"), "");
      assert.equal(readFileSync(environment.NPM_CONFIG_GLOBALCONFIG, "utf8"), "");
    } finally {
      rmSync(isolationRoot, { recursive: true, force: true });
    }
  });

  it("the fixed server uses the same safe environment instead of spreading process.env", () => {
    const source = readFileSync(resolve(repoRoot, "scripts/memory/start-fixed-memmy.mjs"), "utf8");
    assert.match(source, /env: createSafeChildProcessEnvironment\(/u);
    assert.doesNotMatch(source, /\.\.\.process\.env/u);
  });

  it("invalidates the cache when the compiled Memory dist is changed", () => {
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
      assert.equal(validateFixedMemmyCache(fakeRepo), true);
      const evidenceBefore = readFileSync(resolve(cache, FIXED_MEMMY_EVIDENCE_FILE), "utf8");
      writeFileSync(serverEntry, "export const runtime = 'tampered';\n");
      assert.equal(validateFixedMemmyCache(fakeRepo), false);
      assert.equal(readFileSync(resolve(cache, FIXED_MEMMY_EVIDENCE_FILE), "utf8"), evidenceBefore);
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
      dummy.kill("SIGTERM");
      await new Promise((resolveExit) => dummy.once("exit", resolveExit));
    }
  });
});

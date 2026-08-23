import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  assertManagedSourceIdentity,
  canonicalGitHubOrigin,
  loadManagedSourcesManifest,
} from "./managed-sources.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function createFixture() {
  const parent = mkdtempSync(join(tmpdir(), "chat-managed-source-"));
  temporaryRoots.push(parent);
  const chatRoot = join(parent, "Chat");
  const checkoutRoot = join(parent, "managed", "source");
  mkdirSync(chatRoot);
  mkdirSync(checkoutRoot, { recursive: true });
  git(checkoutRoot, "init", "-b", "stable");
  git(checkoutRoot, "config", "user.name", "Managed Source Test");
  git(checkoutRoot, "config", "user.email", "managed-source@example.invalid");
  git(checkoutRoot, "remote", "add", "origin", "git@github.com:later-3/example.git");
  for (const [path, contents] of [
    ["LICENSE", "MIT\n"],
    ["lock.json", "{}\n"],
    ["src/marker.ts", "export const capability = 1;\n"],
    ["dist/marker.js", "export const capability = 1;\n"],
  ]) {
    const target = join(checkoutRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  git(checkoutRoot, "add", "LICENSE", "lock.json", "src/marker.ts", "dist/marker.js");
  git(checkoutRoot, "commit", "-m", "fixture");
  const commit = git(checkoutRoot, "rev-parse", "HEAD");
  const source = {
    id: "example",
    repository: "https://github.com/later-3/example.git",
    branch: "stable",
    commit,
    checkoutPath: "managed/source",
    packageManager: "npm@1.0.0",
    lockfile: "lock.json",
    installCommand: ["npm", "ci"],
    buildCommands: [["npm", "run", "build"]],
    licenseFiles: ["LICENSE"],
    sourceMarkers: [{ path: "src/marker.ts", contains: ["capability = 1"] }],
    runtimeMarkers: [{ path: "dist/marker.js", contains: ["capability = 1"] }],
    linkedPackages: [
      { consumer: "packages/example", dependency: "@example/pkg", sourcePath: "packages/pkg" },
    ],
  };
  return { chatRoot, checkoutRoot, source };
}

describe("managed sources", () => {
  it("accepts the committed manifest and canonicalizes SSH origins", () => {
    const manifest = loadManagedSourcesManifest();
    const packageManifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(
      manifest.toolchain.node,
      readFileSync(join(process.cwd(), ".node-version"), "utf8").trim(),
    );
    assert.equal(manifest.toolchain.chatPackageManager, packageManifest.packageManager);
    assert.deepEqual(manifest.sources.map((source) => source.id).sort(), ["dsh", "pi"]);
    assert.deepEqual(manifest.sources.find((source) => source.id === "pi")?.buildCommands, [
      ["npm", "run", "build:offline"],
    ]);
    assert.deepEqual(manifest.sources.find((source) => source.id === "dsh")?.buildCommands, [
      ["corepack", "pnpm@11.7.0", "run", "build:lib"],
    ]);
    assert.deepEqual(
      manifest.sources
        .find((source) => source.id === "pi")
        ?.buildInputs.map((input) => ({
          id: input.id,
          sha256: input.sha256,
        })),
      [
        {
          id: "pi-model-data-v0.84.2",
          sha256: "96a9efad258fa6fa89f661bbf830c356dd3baf6cd06c6543ce4e8253c143460e",
        },
      ],
    );
    assert.equal(
      canonicalGitHubOrigin("git@github.com:later-3/pi.git"),
      "https://github.com/later-3/pi.git",
    );
  });

  it("accepts exact origin, branch, HEAD and source/runtime markers", () => {
    const fixture = createFixture();
    assert.equal(
      assertManagedSourceIdentity(fixture.source, fixture.chatRoot, { runtime: true }),
      realpathSync(fixture.checkoutRoot),
    );
  });

  it("fails closed when origin drifts", () => {
    const fixture = createFixture();
    git(fixture.checkoutRoot, "remote", "set-url", "origin", "https://github.com/other/source.git");
    assert.throws(
      () => assertManagedSourceIdentity(fixture.source, fixture.chatRoot),
      /origin漂移/u,
    );
  });

  it("fails closed when HEAD drifts", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.checkoutRoot, "next.txt"), "next\n");
    git(fixture.checkoutRoot, "add", "next.txt");
    git(fixture.checkoutRoot, "commit", "-m", "drift");
    assert.throws(() => assertManagedSourceIdentity(fixture.source, fixture.chatRoot), /HEAD漂移/u);
  });

  it("fails closed when a runtime marker is missing", () => {
    const fixture = createFixture();
    const source = {
      ...fixture.source,
      runtimeMarkers: [{ path: "dist/marker.js", contains: ["capability = 2"] }],
    };
    assert.throws(
      () => assertManagedSourceIdentity(source, fixture.chatRoot, { runtime: true }),
      /运行能力 marker缺失/u,
    );
  });
});

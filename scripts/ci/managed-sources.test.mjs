import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  assertManagedLinks,
  assertManagedSourceIdentity,
  canonicalGitHubOrigin,
  loadManagedSourcesManifest,
  recoverInterruptedBuildInputs,
  resolveSafePath,
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
    buildInputs: [],
    licenseFiles: ["LICENSE"],
    sourceMarkers: [{ path: "src/marker.ts", contains: ["capability = 1"] }],
    runtimeMarkers: [{ path: "dist/marker.js", contains: ["capability = 1"] }],
    linkedPackages: [
      { consumer: "packages/example", dependency: "@example/pkg", sourcePath: "packages/pkg" },
    ],
  };
  return { chatRoot, checkoutRoot, source };
}

function commitFixture(fixture, message) {
  git(fixture.checkoutRoot, "add", "-A");
  git(fixture.checkoutRoot, "commit", "-m", message);
  fixture.source.commit = git(fixture.checkoutRoot, "rev-parse", "HEAD");
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

  it("fails closed when branch or dirty state drifts", () => {
    const branchFixture = createFixture();
    git(branchFixture.checkoutRoot, "checkout", "-b", "other");
    assert.throws(
      () => assertManagedSourceIdentity(branchFixture.source, branchFixture.chatRoot),
      /branch漂移/u,
    );

    const dirtyFixture = createFixture();
    writeFileSync(join(dirtyFixture.checkoutRoot, "dirty.txt"), "dirty\n");
    assert.throws(
      () => assertManagedSourceIdentity(dirtyFixture.source, dirtyFixture.chatRoot),
      /未提交改动/u,
    );
  });

  it("fails closed when a license disappears", () => {
    const fixture = createFixture();
    rmSync(join(fixture.checkoutRoot, "LICENSE"));
    commitFixture(fixture, "remove license");
    assert.throws(
      () => assertManagedSourceIdentity(fixture.source, fixture.chatRoot),
      /许可证路径缺失/u,
    );
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

  it("fails closed when a source marker is missing", () => {
    const fixture = createFixture();
    const source = {
      ...fixture.source,
      sourceMarkers: [{ path: "src/marker.ts", contains: ["capability = 2"] }],
    };
    assert.throws(
      () => assertManagedSourceIdentity(source, fixture.chatRoot),
      /源码能力 marker缺失/u,
    );
  });

  it("accepts only the exact linked source package", () => {
    const fixture = createFixture();
    const sourcePackage = join(fixture.checkoutRoot, "packages/pkg");
    mkdirSync(sourcePackage, { recursive: true });
    writeFileSync(join(sourcePackage, "package.json"), '{"name":"@example/pkg"}\n');
    commitFixture(fixture, "add linked package");

    const consumer = join(fixture.chatRoot, "packages/example");
    const linkParent = join(consumer, "node_modules/@example");
    mkdirSync(linkParent, { recursive: true });
    const installed = join(linkParent, "pkg");
    symlinkSync(sourcePackage, installed, "dir");
    assert.doesNotThrow(() => assertManagedLinks({ sources: [fixture.source] }, fixture.chatRoot));

    unlinkSync(installed);
    const otherPackage = mkdtempSync(join(tmpdir(), "chat-managed-other-package-"));
    temporaryRoots.push(otherPackage);
    writeFileSync(join(otherPackage, "package.json"), '{"name":"@example/pkg"}\n');
    symlinkSync(otherPackage, installed, "dir");
    assert.throws(
      () => assertManagedLinks({ sources: [fixture.source] }, fixture.chatRoot),
      /解析漂移/u,
    );
  });

  it("rejects traversal, Windows paths, and symlinks for every manifest path family", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "config/managed-sources.json"), "utf8"),
    );
    const mutations = [
      (copy) => (copy.sources[0].licenseFiles[0] = "../LICENSE"),
      (copy) => (copy.sources[0].sourceMarkers[0].path = "..\\marker"),
      (copy) => (copy.sources[0].runtimeMarkers[0].path = "/tmp/runtime"),
      (copy) => (copy.sources[0].buildInputs[0].targetPath = "packages/../outside"),
      (copy) => (copy.sources[1].linkedPackages[0].sourcePath = "C:\\outside"),
    ];
    for (const mutate of mutations) {
      const root = mkdtempSync(join(tmpdir(), "chat-managed-manifest-"));
      temporaryRoots.push(root);
      const copy = structuredClone(manifest);
      mutate(copy);
      const path = join(root, "manifest.json");
      writeFileSync(path, JSON.stringify(copy));
      assert.throws(() => loadManagedSourcesManifest(path), /安全相对路径/u);
    }

    const fixture = createFixture();
    const outside = mkdtempSync(join(tmpdir(), "chat-managed-outside-"));
    temporaryRoots.push(outside);
    symlinkSync(outside, join(fixture.checkoutRoot, "escaped"));
    assert.throws(
      () => resolveSafePath(fixture.checkoutRoot, "escaped/file", "marker"),
      /symlink/u,
    );
  });

  it("restores original ignored Build Input after an interrupted process", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.checkoutRoot, ".gitignore"), "generated/\n.chat-build-input-*\n");
    commitFixture(fixture, "ignore build input");

    const input = {
      id: "fixed-data",
      targetPath: "generated/data",
      markerPath: ".manifest.json",
      markerSha256: "0c3071418e6356e614898c84ed064ca95e88551bc0811b534bdf1952ecdae534",
    };
    fixture.source.buildInputs = [input];
    const target = join(fixture.checkoutRoot, input.targetPath);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "original.txt"), "original\n");

    const staging = join(fixture.checkoutRoot, ".chat-build-input-interrupted");
    mkdirSync(staging);
    writeFileSync(
      join(staging, "state.json"),
      `${JSON.stringify({ schemaVersion: 1, inputId: input.id, targetPath: input.targetPath })}\n`,
    );
    renameSync(target, join(staging, "previous"));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, input.markerPath), "fixed\n");

    recoverInterruptedBuildInputs(fixture.source, fixture.checkoutRoot);
    assert.equal(readFileSync(join(target, "original.txt"), "utf8"), "original\n");
    assert.equal(existsSync(staging), false);
  });
});

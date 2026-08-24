import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function workspaceDirectories() {
  const manifest = parse(readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const directories = [];
  for (const pattern of manifest.packages ?? []) {
    const match = /^(apps|packages)\/\*$/u.exec(pattern);
    assert.ok(match, `README门尚不支持workspace pattern：${pattern}`);
    const parent = resolve(repoRoot, match[1]);
    for (const name of readdirSync(parent).sort()) {
      const directory = resolve(parent, name);
      if (existsSync(resolve(directory, "package.json"))) directories.push(directory);
    }
  }
  return directories;
}

function markdownLinks(source) {
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1]);
}

function assertRelativeLinks(source, directory, label) {
  for (const target of markdownLinks(source)) {
    if (/^(?:[a-z]+:|#)/iu.test(target)) continue;
    const path = resolve(directory, decodeURIComponent(target.split("#", 1)[0]));
    assert.equal(path.startsWith(`${repoRoot}/`), true, `${label}链接越出仓库：${target}`);
    assert.equal(existsSync(path), true, `${label}链接不存在：${target}`);
  }
}

describe("workspace README navigation", () => {
  it("keeps all 14 current workspaces documented and makes future additions fail closed", () => {
    const directories = workspaceDirectories();
    assert.equal(directories.length, 14);
    for (const directory of directories) {
      assert.equal(existsSync(resolve(directory, "README.md")), true, `${directory}缺少README.md`);
    }
  });

  it("requires responsibility, exclusions, entries, boundaries, and real package commands", () => {
    for (const directory of workspaceDirectories()) {
      const packageManifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
      const source = readFileSync(resolve(directory, "README.md"), "utf8");
      for (const heading of ["## 拥有", "## 不拥有", "## 入口与边界", "## 命令"]) {
        assert.match(
          source,
          new RegExp(`^${heading}$`, "mu"),
          `${packageManifest.name}缺少${heading}`,
        );
      }
      const commands = [...source.matchAll(/`pnpm --filter ([^\s`]+) ([^\s`]+)`/gu)];
      assert.ok(commands.length >= 3, `${packageManifest.name}至少声明build/typecheck/test命令`);
      for (const [, packageName, scriptName] of commands) {
        assert.equal(
          packageName,
          packageManifest.name,
          `${packageManifest.name} README命令包名漂移`,
        );
        assert.ok(
          packageManifest.scripts?.[scriptName] !== undefined,
          `${packageManifest.name} README声明不存在脚本：${scriptName}`,
        );
      }
    }
  });

  it("requires every relative README link to resolve inside the repository", () => {
    for (const directory of workspaceDirectories()) {
      const source = readFileSync(resolve(directory, "README.md"), "utf8");
      assertRelativeLinks(source, directory, "README");
    }
  });

  it("keeps the 0–15 minute entry linked and every documented root command real", () => {
    const path = resolve(repoRoot, "docs/getting-started/quick-context.md");
    const source = readFileSync(path, "utf8");
    assertRelativeLinks(source, dirname(path), "quick-context");
    const packageManifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const commands = [...source.matchAll(/\bpnpm ([a-z0-9:-]+)/giu)].map((match) => match[1]);
    assert.ok(commands.length >= 6, "quick-context应声明首验、完成门和诊断命令");
    for (const command of commands) {
      assert.ok(
        packageManifest.scripts?.[command] !== undefined,
        `quick-context虚构命令：${command}`,
      );
    }
  });
});

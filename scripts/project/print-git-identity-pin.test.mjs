import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { computeGitIdentityPin, pinsForArguments } from "./print-git-identity-pin.mjs";

const exec = promisify(execFile);
const repoRoot = new URL("../..", import.meta.url).pathname;

test("只输出稳定Pin且支持父仓中的嵌套Root", async () => {
  const repository = await realpath(await mkdtemp(join(tmpdir(), "chat-git-pin-")));
  try {
    const nested = join(repository, "customer", "content");
    await mkdir(nested, { recursive: true });
    await writeFile(join(repository, "README.md"), "# identity\n");
    await exec("git", ["init", repository]);
    const first = computeGitIdentityPin(nested);
    const second = pinsForArguments(["root_content", nested]);
    assert.match(first, /^[0-9a-f]{64}$/u);
    assert.deepEqual(second, { root_content: first });
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("拒绝重复rootId与含dot segment的非规范路径", () => {
  assert.throws(() => pinsForArguments(["root_demo", "/tmp", "root_demo", "/tmp"]));
  assert.throws(() => computeGitIdentityPin("/tmp/demo/../demo"), /not_canonical/u);
});

test("文档中的pnpm入口剥离参数分隔符并只打印可粘贴配置", async () => {
  const repository = await realpath(await mkdtemp(join(tmpdir(), "chat-git-pin-cli-")));
  try {
    await exec("git", ["init", repository]);
    const { stdout, stderr } = await exec(
      "pnpm",
      ["--silent", "project:git-identity-pin", "--", "root_demo", repository],
      { cwd: repoRoot },
    );
    assert.equal(stderr, "");
    assert.match(
      stdout.trim(),
      /^CHAT_PROJECT_GIT_IDENTITY_PINS_JSON='\{"root_demo":"[0-9a-f]{64}"\}'$/u,
    );
    assert.doesNotMatch(stdout, new RegExp(repository.replaceAll("/", "\\/"), "u"));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

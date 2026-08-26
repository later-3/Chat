import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  computeProjectGitIdentityPin,
  createProjectResourceRegistry,
  ProjectResourceError,
} from "./registry.js";

const exec = promisify(execFile);

async function realRepository() {
  const root = await mkdtemp(join(tmpdir(), "chat-project-root-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "README.md"), "# Demo\n");
  await writeFile(join(root, "docs", "architecture.md"), "# Architecture\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }),
  );
  await exec("git", ["init", root]);
  await exec("git", ["-C", root, "config", "user.email", "project@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Project Test"]);
  await exec("git", ["-C", root, "add", "README.md", "docs/architecture.md", "package.json"]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  await exec("git", ["-C", root, "branch", "-M", "codex/test-evidence"]);
  return realpath(root);
}

async function gitOutput(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args]);
  return stdout.trim();
}

describe("Project Resource Registry真实只读观察", () => {
  it("从真实Git、Markdown和package scripts生成严格Observation", async () => {
    const root = await realRepository();
    const registry = await createProjectResourceRegistry({
      CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
        {
          rootId: "root_demo",
          displayName: "Demo",
          canonicalPath: root,
          enabledAdapters: [
            "local-git-workspace.v1",
            "project-document-manifest.v1",
            "package-script-catalog.v1",
          ],
        },
      ]),
    });
    const observed = await registry.observe("root_demo");
    expect(observed.descriptor.displayName).toBe("Demo");
    expect(observed.data.git.headSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(observed.data.git.trackedFileCount).toBe(3);
    expect(observed.data.documents.map((item) => item.relativePath)).toEqual([
      "README.md",
      "docs/architecture.md",
    ]);
    expect(observed.data.scripts).toEqual([
      { name: "build", command: "tsc" },
      { name: "test", command: "vitest run" },
    ]);
  }, 15_000);

  it("浏览器未知rootId失败关闭，且符号链接文档不会越过允许根", async () => {
    const root = await realRepository();
    const outside = await mkdtemp(join(tmpdir(), "chat-project-outside-"));
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(join(outside, "secret.md"), join(root, "docs", "linked.md"));
    const registry = await createProjectResourceRegistry({
      CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
        {
          rootId: "root_demo",
          displayName: "Demo",
          canonicalPath: root,
          enabledAdapters: ["local-git-workspace.v1", "project-document-manifest.v1"],
        },
      ]),
    });
    await expect(registry.observe("root_unknown")).rejects.toMatchObject({
      code: "project_root_not_allowed",
    });
    const observed = await registry.observe("root_demo");
    expect(observed.data.documents.some((item) => item.relativePath === "docs/linked.md")).toBe(
      false,
    );
  }, 15_000);

  it("拒绝重复rootId和非目录配置", async () => {
    const root = await realRepository();
    await expect(
      createProjectResourceRegistry({
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_dup",
            displayName: "A",
            canonicalPath: root,
            enabledAdapters: ["local-git-workspace.v1"],
          },
          {
            rootId: "root_dup",
            displayName: "B",
            canonicalPath: root,
            enabledAdapters: ["local-git-workspace.v1"],
          },
        ]),
      }),
    ).rejects.toBeInstanceOf(ProjectResourceError);
  });

  it("只接受存在、可从声明branch到达且实际修改绑定Root的commit", async () => {
    const root = await realRepository();
    const branch = await gitOutput(root, ["branch", "--show-current"]);
    const initialSha = await gitOutput(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "README.md"), "# Verified evidence\n");
    await exec("git", ["-C", root, "add", "README.md"]);
    await exec("git", ["-C", root, "commit", "-m", "verified evidence"]);
    const evidenceSha = await gitOutput(root, ["rev-parse", "HEAD"]);
    const gitIdentityPin = await computeProjectGitIdentityPin(root);
    const registry = await createProjectResourceRegistry({
      CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
        {
          rootId: "root_demo",
          displayName: "Demo",
          canonicalPath: root,
          enabledAdapters: ["local-git-workspace.v1"],
          gitEvidenceEnabled: true,
        },
      ]),
      CHAT_PROJECT_GIT_IDENTITY_PINS_JSON: JSON.stringify({ root_demo: gitIdentityPin }),
    });

    await expect(
      registry.verifyGitEvidence!({ rootId: "root_demo", branch, commitSha: evidenceSha }),
    ).resolves.toEqual({
      rootId: "root_demo",
      branch,
      commitSha: evidenceSha,
      changedTrackedPathCount: 1,
    });
    await expect(
      registry.verifyGitEvidence!({ rootId: "root_demo", branch, commitSha: initialSha }),
    ).rejects.toMatchObject({ code: "project_git_evidence_commit_not_branch_tip" });
    await expect(
      registry.verifyGitEvidence!({
        rootId: "root_demo",
        branch: "codex/missing",
        commitSha: evidenceSha,
      }),
    ).rejects.toMatchObject({ code: "project_git_evidence_branch_not_found" });
    await expect(
      registry.verifyGitEvidence!({
        rootId: "root_demo",
        branch,
        commitSha: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "project_git_evidence_commit_not_found" });

    await exec("git", ["-C", root, "checkout", "-b", "codex/unreachable", initialSha]);
    await writeFile(join(root, "side.md"), "side branch\n");
    await exec("git", ["-C", root, "add", "side.md"]);
    await exec("git", ["-C", root, "commit", "-m", "side branch"]);
    const unreachableSha = await gitOutput(root, ["rev-parse", "HEAD"]);
    await expect(
      registry.verifyGitEvidence!({ rootId: "root_demo", branch, commitSha: unreachableSha }),
    ).rejects.toMatchObject({ code: "project_git_evidence_commit_not_branch_tip" });
  }, 15_000);

  it("嵌套且零tracked的绑定Root不能借用父仓其他路径的SHA", async () => {
    const repository = await mkdtemp(join(tmpdir(), "chat-parent-repository-"));
    const nestedRoot = join(repository, "customer", "ZIJI", "Content Lab");
    await mkdir(nestedRoot, { recursive: true });
    await writeFile(join(nestedRoot, "untracked-draft.md"), "not product evidence\n");
    await writeFile(join(repository, "README.md"), "# Parent repository\n");
    await exec("git", ["init", repository]);
    await exec("git", ["-C", repository, "config", "user.email", "project@example.test"]);
    await exec("git", ["-C", repository, "config", "user.name", "Project Test"]);
    await exec("git", ["-C", repository, "add", "README.md"]);
    await exec("git", ["-C", repository, "commit", "-m", "parent only"]);
    await exec("git", ["-C", repository, "branch", "-M", "codex/content-lab"]);
    const branch = await gitOutput(repository, ["branch", "--show-current"]);
    const parentOnlySha = await gitOutput(repository, ["rev-parse", "HEAD"]);
    const gitIdentityPin = await computeProjectGitIdentityPin(nestedRoot);
    const registry = await createProjectResourceRegistry({
      CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
        {
          rootId: "root_contentlab",
          displayName: "Content Lab",
          canonicalPath: nestedRoot,
          enabledAdapters: ["local-git-workspace.v1"],
          gitEvidenceEnabled: true,
        },
      ]),
      CHAT_PROJECT_GIT_IDENTITY_PINS_JSON: JSON.stringify({
        root_contentlab: gitIdentityPin,
      }),
    });

    await expect(
      registry.verifyGitEvidence!({
        rootId: "root_contentlab",
        branch,
        commitSha: parentOnlySha,
      }),
    ).rejects.toMatchObject({ code: "project_git_evidence_root_untouched" });

    await writeFile(join(nestedRoot, "brief.md"), "# Content Lab\n");
    await exec("git", ["-C", repository, "add", "customer/ZIJI/Content Lab/brief.md"]);
    await exec("git", ["-C", repository, "commit", "-m", "content lab evidence"]);
    const contentLabSha = await gitOutput(repository, ["rev-parse", "HEAD"]);
    await expect(
      registry.verifyGitEvidence!({
        rootId: "root_contentlab",
        branch,
        commitSha: contentLabSha,
      }),
    ).resolves.toMatchObject({ changedTrackedPathCount: 1 });
  }, 15_000);

  it("默认关闭Git证据，且启用时必须由外置耐久身份Pin授权", async () => {
    const root = await realRepository();
    const branch = await gitOutput(root, ["branch", "--show-current"]);
    const commitSha = await gitOutput(root, ["rev-parse", "HEAD"]);
    const disabled = await createProjectResourceRegistry({
      CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
        {
          rootId: "root_demo",
          displayName: "Demo",
          canonicalPath: root,
          enabledAdapters: ["local-git-workspace.v1"],
          gitEvidenceEnabled: false,
        },
      ]),
    });
    await expect(
      disabled.verifyGitEvidence!({ rootId: "root_demo", branch, commitSha }),
    ).rejects.toMatchObject({ code: "project_git_evidence_disabled" });

    await expect(
      createProjectResourceRegistry({
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_demo",
            displayName: "Demo",
            canonicalPath: root,
            enabledAdapters: ["local-git-workspace.v1"],
            gitEvidenceEnabled: true,
          },
        ]),
      }),
    ).rejects.toMatchObject({ code: "project_git_identity_not_pinned" });
  });

  it("外置Pin跨进程重启仍拒绝嵌套git init劫持绑定Root", async () => {
    const repository = await realRepository();
    const nestedRoot = join(repository, "customer", "content-lab");
    await mkdir(nestedRoot, { recursive: true });
    const expectedPin = await computeProjectGitIdentityPin(nestedRoot);

    // 模拟API停止期间，同UID进程把嵌套目录改造成另一仓库；重启不能重新学习它。
    await exec("git", ["init", nestedRoot]);
    await expect(
      createProjectResourceRegistry({
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_nested",
            displayName: "Nested",
            canonicalPath: nestedRoot,
            enabledAdapters: ["local-git-workspace.v1"],
            gitEvidenceEnabled: true,
          },
        ]),
        CHAT_PROJECT_GIT_IDENTITY_PINS_JSON: JSON.stringify({ root_nested: expectedPin }),
      }),
    ).rejects.toMatchObject({ code: "project_git_identity_drift" });
  });

  it("安装CLI与Registry使用同一Git身份Pin合同", async () => {
    const root = await realRepository();
    const expected = await computeProjectGitIdentityPin(root);
    const { stdout } = await exec(process.execPath, [
      resolve(import.meta.dirname, "../../../scripts/project/print-git-identity-pin.mjs"),
      "root_demo",
      root,
    ]);
    const match = /"root_demo":"([0-9a-f]{64})"/u.exec(stdout);
    expect(match?.[1]).toBe(expected);
  });
});

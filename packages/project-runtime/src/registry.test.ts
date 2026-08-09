import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createProjectResourceRegistry, ProjectResourceError } from "./registry.js";

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
  return root;
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
  });

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
  });

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
});

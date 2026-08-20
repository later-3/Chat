import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  PromptSourceFileOpenError,
  PromptSourceFileOpener,
} from "../src/prompt-source-file-opener.ts";

test("Prompt来源只允许Catalog与受管Workspace文件，并把本机已安装编辑器投影给浏览器", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-prompt-source-open-"));
  const outside = await mkdtemp(join(tmpdir(), "chat-prompt-source-outside-"));
  const launched: { id: string; absolutePath: string }[] = [];
  try {
    await mkdir(resolve(root, "prompts/regions"), { recursive: true });
    await mkdir(resolve(root, "prompts/fragments/rules"), { recursive: true });
    await mkdir(resolve(root, ".data/prompts/global/rules/pfg_one"), { recursive: true });
    await mkdir(resolve(root, ".chat/prompts/rules/pfg_two"), { recursive: true });
    await writeFile(resolve(root, "prompts/regions/catalog.md"), "# Regions\n", "utf8");
    await writeFile(resolve(root, "prompts/fragments/rules/evidence.md"), "# Evidence\n", "utf8");
    await writeFile(resolve(root, "AGENTS.md"), "# Workspace\n", "utf8");
    await writeFile(
      resolve(root, ".data/prompts/global/rules/pfg_one/pfr_one.md"),
      "# Global\n",
      "utf8",
    );
    await writeFile(
      resolve(root, ".chat/prompts/rules/pfg_two/pfr_two.md"),
      "# Workspace Prompt\n",
      "utf8",
    );
    await writeFile(resolve(outside, "outside.md"), "outside\n", "utf8");
    await symlink(resolve(outside, "outside.md"), resolve(root, "prompts/fragments/escape.md"));
    await writeFile(
      resolve(root, "prompts/catalog.json"),
      JSON.stringify({
        regionSource: { relativePath: "prompts/regions/catalog.md" },
        fragments: [
          { relativePath: "prompts/fragments/rules/evidence.md" },
          { relativePath: "prompts/fragments/escape.md" },
        ],
      }),
      "utf8",
    );
    const opener = await PromptSourceFileOpener.create({
      repoRoot: root,
      env: {
        CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
          {
            rootId: "root_chat",
            displayName: "Chat",
            canonicalPath: root,
            enabledAdapters: [],
          },
        ]),
      },
      platform: "darwin",
      applicationExists: async (path) =>
        path.endsWith("Visual Studio Code.app") || path.endsWith("Trae CN.app"),
      launch: async (application, absolutePath) => {
        launched.push({ id: application.id, absolutePath });
      },
    });

    assert.deepEqual(
      opener.openers().items.map(({ id }) => id),
      ["vscode", "trae-cn", "system-default"],
    );
    await opener.open({
      relativePath: "prompts/fragments/rules/evidence.md",
      openerId: "trae-cn",
    });
    await opener.open({ relativePath: "root_chat/AGENTS.md", openerId: "vscode" });
    await opener.open({
      relativePath: "root_chat/.chat/prompts/rules/pfg_two/pfr_two.md",
      openerId: "vscode",
    });
    await opener.open({
      relativePath: ".data/prompts/global/rules/pfg_one/pfr_one.md",
      openerId: "vscode",
    });
    assert.deepEqual(launched, [
      {
        id: "trae-cn",
        absolutePath: await realpath(resolve(root, "prompts/fragments/rules/evidence.md")),
      },
      { id: "vscode", absolutePath: await realpath(resolve(root, "AGENTS.md")) },
      {
        id: "vscode",
        absolutePath: await realpath(resolve(root, ".chat/prompts/rules/pfg_two/pfr_two.md")),
      },
      {
        id: "vscode",
        absolutePath: await realpath(
          resolve(root, ".data/prompts/global/rules/pfg_one/pfr_one.md"),
        ),
      },
    ]);
    await assert.rejects(
      opener.open({ relativePath: "README.md", openerId: "vscode" }),
      (error) =>
        error instanceof PromptSourceFileOpenError &&
        error.code === "lifeos_prompt_source_not_found",
    );
    await assert.rejects(
      opener.open({ relativePath: "root_chat/README.md", openerId: "vscode" }),
      (error) =>
        error instanceof PromptSourceFileOpenError &&
        error.code === "lifeos_prompt_source_not_found",
    );
    await assert.rejects(
      opener.open({ relativePath: "prompts/fragments/escape.md", openerId: "vscode" }),
      (error) =>
        error instanceof PromptSourceFileOpenError &&
        error.code === "lifeos_prompt_source_forbidden",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

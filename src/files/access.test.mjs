import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openProject } from "../projects/registry.ts";
import { getAllowedFileRoots, normalizeSlashes } from "./access.ts";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./path-security.ts";

test("file access comes from registered Projects rather than the Chat process directory", async (t) => {
  const chatHome = fs.mkdtempSync(path.join(os.tmpdir(), "chat-file-roots-"));
  t.after(() => fs.rmSync(chatHome, { recursive: true, force: true }));
  const projectRoot = path.join(chatHome, "workspace");
  fs.mkdirSync(projectRoot);

  assert.equal((await getAllowedFileRoots(chatHome)).has(normalizeSlashes(process.cwd())), false);
  await openProject({ path: projectRoot, chatHome });
  assert.equal((await getAllowedFileRoots(chatHome)).has(normalizeSlashes(fs.realpathSync(projectRoot))), true);
});

test("file roots allow descendants but reject sibling prefixes and traversal", () => {
  const roots = new Set(["/workspace/repo"]);
  assert.equal(isFilePathAllowed("/workspace/repo/src/index.ts", roots), true);
  assert.equal(isFilePathAllowed("/workspace/repository/secret", roots), false);
  assert.equal(isFilePathAllowed("/workspace/repo/../secret", roots), false);
});

test("an allowed lexical path cannot escape through a symbolic link", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isFilePathAllowed(target, roots), true);
  assert.equal(isExistingFilePathAllowed(target, roots), false);
});

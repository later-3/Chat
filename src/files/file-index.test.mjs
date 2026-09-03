import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildFileIndexEntries,
  listFileIndex,
  searchFileIndex,
} from "./file-index.ts";

test("file index derives directories and ranks name matches before path matches", () => {
  const entries = buildFileIndexEntries([
    "src/chat/session.ts",
    "src/files/chat.ts",
    "docs/chat-guide.md",
    "README.md",
  ]);
  assert.deepEqual(
    searchFileIndex(entries, "chat").map((entry) => entry.path),
    ["src/chat", "docs/chat-guide.md", "src/files/chat.ts", "src/chat/session.ts"],
  );
});

test("non-git file indexing skips generated directories and Python bytecode", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-file-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "cached.pyc"), "ignored\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "ignored\n");

  assert.deepEqual(await listFileIndex(root), {
    files: ["src/index.ts"],
    hardTruncated: false,
  });
});

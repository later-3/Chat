import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatHome, getChatHomePaths } from "./chat-home.ts";

test("Chat Home owns process-wide runtime data and rebuildable caches", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const paths = await ensureChatHome(root);
  assert.equal(paths.workflowDataDir, path.join(root, "runtime", "workflow-data"));
  assert.equal(paths.fastEmbedCacheDir, path.join(root, "cache", "fastembed"));
  assert.equal(fs.statSync(paths.workflowDataDir).isDirectory(), true);
  assert.equal(fs.statSync(paths.fastEmbedCacheDir).isDirectory(), true);
  assert.deepEqual(getChatHomePaths(root), paths);
});

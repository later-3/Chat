import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureChatRuntimeInitialized } from "./runtime-initialization.ts";

test("Backend initialization prepares only Workflow-private Skills before Workflow Steps run", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-runtime-initialization-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");

  await ensureChatRuntimeInitialized({ projectRoot: root, chatHome });

  for (const skill of ["memory", "rule-library"]) {
    const content = fs.readFileSync(
      path.join(chatHome, "runtime", "skills", skill, "SKILL.md"),
      "utf8",
    );
    assert.match(content, new RegExp(`name:\\s*${skill}`));
  }
  assert.equal(
    fs.existsSync(path.join(chatHome, "runtime", "skills", "chat-architecture")),
    false,
  );
});

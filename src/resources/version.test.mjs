import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { describeResourceVersion, qualifiedResourceAddress } from "./version.ts";

test("file resources expose a stable qualified address and content version", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "chat-resource-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "SKILL.md");
  await writeFile(path, "memory\n");
  const version = await describeResourceVersion(path);
  assert.match(version?.contentHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(qualifiedResourceAddress({
    kind: "skill",
    id: "memory",
    scope: "project",
    projectId: "chat",
  }), "project/chat:skill/memory");
});

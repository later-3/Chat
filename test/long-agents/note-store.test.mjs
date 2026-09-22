import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { contentHash, inspectWorkspaceFile, materializeWorkspaceFile, noteStorePaths, versionFileName, writeImmutableFile } from "../../src/long-agents/artifacts/note-store.ts";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("LA4-N1 an immutable version file is never replaced, not even for the same revision", async () => {
  const dir = tempDir("chat-note-store-");
  const name = versionFileName(1, "a".repeat(64));
  assert.match(name, /^r1-aaaaaaaa\.md$/);
  const first = await writeImmutableFile(dir, name, "version one", "test");
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(first.path, "utf8"), "version one");
  // Identical content: reuse the same file instead of writing again.
  const again = await writeImmutableFile(dir, name, "version one", "test");
  assert.equal(again.path, first.path);
  assert.equal(again.created, false);
  // Different content under the same name: a new file is allocated, the original stays intact.
  const changed = await writeImmutableFile(dir, name, "version one changed", "test");
  assert.notEqual(changed.path, first.path);
  assert.equal(fs.readFileSync(first.path, "utf8"), "version one");
  assert.equal(fs.readFileSync(changed.path, "utf8"), "version one changed");
  assert.equal(fs.readdirSync(dir).filter((entry) => entry.endsWith(".md")).length, 2);
  assert.equal(fs.readdirSync(dir).some((entry) => entry.startsWith(".tmp-")), false, "no temporary files are left behind");
});

test("LA4-N2 the user-visible note file is created once and never replaced", async () => {
  const dir = tempDir("chat-note-user-");
  const file = path.join(dir, "notes", "night.md");
  assert.equal(await materializeWorkspaceFile(file, "generated", "test"), "created");
  assert.equal(fs.readFileSync(file, "utf8"), "generated");
  fs.writeFileSync(file, "user edit");
  assert.equal(await materializeWorkspaceFile(file, "generated again", "test"), "exists");
  assert.equal(fs.readFileSync(file, "utf8"), "user edit");
  assert.equal(fs.readdirSync(path.dirname(file)).some((entry) => entry.includes(".tmp")), false);
});

test("LA4-N3 workspace classification keeps external content out of our versions", async () => {
  const dir = tempDir("chat-note-inspect-");
  const file = path.join(dir, "note.md");
  const preserved = [];
  const preserve = async (content) => {
    preserved.push(content);
    return { source: "workspace", contentHash: "h", content, preservedFile: null, at: new Date().toISOString() };
  };
  fs.writeFileSync(file, "current");
  assert.equal((await inspectWorkspaceFile(file, new Set(), contentHash("current"), preserve)).state, "clean");
  fs.writeFileSync(file, "previous");
  assert.equal((await inspectWorkspaceFile(file, new Set([contentHash("previous")]), contentHash("current"), preserve)).state, "older");
  fs.writeFileSync(file, "manual edit");
  const edited = await inspectWorkspaceFile(file, new Set([contentHash("previous")]), contentHash("current"), preserve);
  assert.equal(edited.state, "edited");
  assert.equal(edited.conflict.content, "manual edit");
  assert.deepEqual(preserved, ["manual edit"]);
  fs.rmSync(file);
  assert.equal((await inspectWorkspaceFile(file, new Set(), contentHash("current"), preserve)).state, "missing");
});

test("LA4-N4 note store paths are stable, colocated and hidden", async () => {
  const dir = tempDir("chat-note-paths-");
  const canonical = path.join(dir, "notes", "night.md");
  const first = noteStorePaths(canonical);
  const second = noteStorePaths(canonical);
  assert.deepEqual(first, second);
  assert.equal(path.dirname(first.storeDir), path.join(dir, "notes", ".chat-notes"));
  assert.equal(first.storeDir.startsWith(dir), true);
  assert.match(path.basename(first.storeDir), /^night\.md-[a-f0-9]{8}$/);
  assert.notEqual(noteStorePaths(path.join(dir, "notes", "other.md")).storeDir, first.storeDir);
});

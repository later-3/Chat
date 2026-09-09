import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getParentDirectory,
  listDirectories,
  normalizeDirectory,
  resolveDirectory,
} from "../../src/files/directory-browser.ts";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-dir-browser-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("directory listing returns sorted subdirectories and skips files and broken links", async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, "alpha"));
  fs.writeFileSync(path.join(root, "notes.txt"), "not a directory");
  fs.symlinkSync(path.join(root, "beta"), path.join(root, "beta-link"));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "broken-link"));

  const directories = await listDirectories(root);
  assert.deepEqual(
    directories.map((entry) => entry.name),
    ["alpha", "beta", "beta-link"],
  );
  assert.equal(directories[0].path, path.join(root, "alpha"));
});

test("directory paths normalize tilde and resolve parents", async (t) => {
  assert.equal(normalizeDirectory("~"), os.homedir());
  assert.equal(normalizeDirectory("~/Code"), path.join(os.homedir(), "Code"));
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("/tmp"), "/");

  const root = fixture(t);
  assert.equal(await resolveDirectory(path.join(root, ".")), fs.realpathSync(root));
  await assert.rejects(resolveDirectory(path.join(root, "missing")));
});

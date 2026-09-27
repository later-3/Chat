import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromeExecutable } from "./cdp.mjs";

test("Linux browser regression finds an executable on PATH, including paths with spaces", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat chrome-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "google-chrome"), "not executable", { mode: 0o600 });
  const chromium = path.join(directory, "chromium");
  fs.writeFileSync(chromium, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(chromeExecutable({ platform: "linux", env: { PATH: directory } }), chromium);
});

test("explicit browser takes precedence and invalid overrides fail instead of skipping tests", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-chrome-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "custom-chrome");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(chromeExecutable({ env: { CHROME_BIN: binary, PATH: "" } }), binary);
  assert.throws(() => chromeExecutable({ env: { CHROME_BIN: "relative-chrome" } }), /CHROME_BIN/);
  assert.throws(() => chromeExecutable({ env: { CHROME_BIN: directory } }), /CHROME_BIN/);
});

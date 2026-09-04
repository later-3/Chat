import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDeviceDirectory,
  loadDeviceDirectory,
} from "./device-directory.ts";

test("the public example is accepted without exposing infrastructure fields", async () => {
  const example = JSON.parse(await readFile(new URL("../deploy/devices.json.example", import.meta.url), "utf8"));
  const directory = buildDeviceDirectory(
    example,
    "https://chat-workstation.example.com",
    "http://127.0.0.1:43110",
  );

  assert.equal(directory.currentDeviceId, "workstation");
  assert.equal(directory.devices.length, 2);
  assert.deepEqual(directory.diagnostics, []);
});

test("a private device config becomes the narrow direct-navigation browser contract", () => {
  assert.deepEqual(buildDeviceDirectory({
    version: 1,
    devices: [
      { id: "workstation", name: "Workstation", url: "https://workstation.example.test/" },
      { id: "server", name: "Server", url: "https://server.example.test/" },
    ],
  }, "https://workstation.example.test/", "http://127.0.0.1:43110"), {
    version: 1,
    currentDeviceId: "workstation",
    devices: [
      { id: "workstation", name: "Workstation", url: "https://workstation.example.test" },
      { id: "server", name: "Server", url: "https://server.example.test" },
    ],
    diagnostics: [],
    selectionMode: "direct",
    gatewayUrl: null,
  });
});

test("private infrastructure fields are rejected instead of reaching the frontend", () => {
  const directory = buildDeviceDirectory({
    version: 1,
    devices: [{
      id: "server",
      name: "Server",
      url: "https://server.example.test",
      account: "private-user",
      identityFile: "/private/key",
    }],
  }, "https://chat.example.test", "http://127.0.0.1:43110");

  assert.equal(directory.devices.length, 1);
  assert.equal(directory.diagnostics[0]?.code, "invalid-device");
  assert.doesNotMatch(JSON.stringify(directory), /private-user|private\/key/);
});

test("missing or malformed private configuration never blocks the current Chat instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chat-devices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "devices.json");

  const missing = await loadDeviceDirectory(configPath, "https://chat.example.test", "http://127.0.0.1:43110");
  assert.equal(missing.currentDeviceId, "local");
  assert.deepEqual(missing.diagnostics, []);

  await writeFile(configPath, "{not-json", "utf8");
  const malformed = await loadDeviceDirectory(configPath, "https://chat.example.test", "http://127.0.0.1:43110");
  assert.equal(malformed.currentDeviceId, "local");
  assert.equal(malformed.diagnostics[0]?.code, "invalid-device-config");
});

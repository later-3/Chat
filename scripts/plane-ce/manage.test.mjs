import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const lock = JSON.parse(await readFile(new URL("./lock.json", import.meta.url), "utf8"));
const rootPackage = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

test("Plane CE deployment lock fixes upstream source, version, license and every image", () => {
  assert.equal(lock.schemaVersion, "chat-plane-ce-lock.v1");
  assert.equal(lock.planeVersion, "1.4.1");
  assert.equal(lock.planeCommit, "5662b761062b0b2f9d42a6578b55481b5b069792");
  assert.equal(lock.license, "AGPL-3.0-only");
  assert.match(lock.compose.url, new RegExp(lock.planeCommit, "u"));
  assert.match(lock.compose.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.keys(lock.images).length, 10);
  for (const image of Object.values(lock.images)) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(image, /:latest(?:@|$)/u);
  }
});

test("manager rejects moving image references after applying the audited upstream Compose", async () => {
  const source = await readFile(new URL("./manage.mjs", import.meta.url), "utf8");
  assert.match(source, /Compose SHA-256与固定工件不一致/u);
  assert.match(source, /locked\.includes\(":latest"\)/u);
  assert.match(source, /--env-file/u);
  assert.match(source, /\.data\/plane-ce/u);
  assert.match(source, /CERT_ACME_CA=\$\{defaultAcmeCa\}/u);
  assert.match(source, /current\.replace\(\/\^CERT_ACME_CA=/u);
});

test("real bootstrap gate requires explicit persistent-write authority and reconciles both providers", async () => {
  const source = await readFile(new URL("./verify-real-bootstrap.ts", import.meta.url), "utf8");
  assert.match(source, /CHAT_PLANE_CE_REAL_TEST !== "1"/u);
  assert.match(source, /plane\.provision/u);
  assert.match(source, /plane\.reconcile/u);
  assert.match(source, /workspace\.provision/u);
  assert.match(source, /workspace\.reconcile/u);
  assert.match(source, /process\.loadEnvFile\(repoEnvironmentPath\)/u);
  assert.doesNotMatch(source, /rmSync|rm\(|DELETE/u);
});

test("real bootstrap gate uses the external lane and both write switches", () => {
  const command = rootPackage.scripts["test:external:plane-ce"];
  assert.match(command, /test-safety-gate\.mjs external/u);
  assert.match(command, /--command-name=test:external:plane-ce/u);
  assert.match(command, /--switch=CHAT_PLANE_CE_REAL_TEST/u);
  assert.match(command, /--credential=CHAT_PLANE_CE_API_TOKEN/u);
  assert.match(command, /verify-real-bootstrap\.ts/u);
});

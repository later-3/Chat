import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRuntimeCredential } from "./runtime-credential.js";

const originalCredentialPath = process.env.CHAT_RUNTIME_CREDENTIAL_PATH;
const originalRuntimeKey = process.env.CHAT_RUNTIME_KEY;
const cleanup: string[] = [];

afterEach(async () => {
  if (originalCredentialPath === undefined) delete process.env.CHAT_RUNTIME_CREDENTIAL_PATH;
  else process.env.CHAT_RUNTIME_CREDENTIAL_PATH = originalCredentialPath;
  if (originalRuntimeKey === undefined) delete process.env.CHAT_RUNTIME_KEY;
  else process.env.CHAT_RUNTIME_KEY = originalRuntimeKey;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Runtime实例凭据", () => {
  it("debug实例使用自己的0600凭据文件且重复读取稳定", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-runtime-credential-"));
    cleanup.push(directory);
    const credentialPath = join(directory, "debug", "runtime-key");
    process.env.CHAT_RUNTIME_CREDENTIAL_PATH = credentialPath;
    delete process.env.CHAT_RUNTIME_KEY;

    const first = await loadRuntimeCredential("/workspace/production");
    const second = await loadRuntimeCredential("/workspace/production");

    expect(second).toBe(first);
    expect(await readFile(credentialPath, "utf8")).toBe(first);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });
});

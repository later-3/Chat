import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest exposes the native DSH bundle patch and client factory contract", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const dsh = manifest.dsh as {
    bundle?: { patch?: unknown };
    client?: { platform?: unknown; inject?: unknown };
  };
  assert.equal(manifest.name, "@chat/dsh-lifeos-bridge");
  assert.equal(manifest.main, "dist/dsh-bundle.js");
  assert.equal(dsh.bundle?.patch, "./cordis.patch.yml");
  assert.equal(dsh.client?.platform, "web");
  assert.deepEqual(dsh.client?.inject, [
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar",
  ]);
});

test("workflow selector uses the additive DSH composer tool-row slot", async () => {
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const picker = await readFile(
    new URL("../src/client/WorkflowPicker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(client, /ctx\.slots\.inject\("conversation\.input\.left"/);
  assert.match(client, /name: "conversation\.input\.left"/);
  assert.doesNotMatch(picker, /PropsRuntime<"conversation\.input\.dock">/);
  assert.match(picker, /PropsRuntime<"conversation\.input\.left">/);
  assert.match(picker, /@deepseek-ai\/dsh-client-ui-primitives/);
});

test("LifeOS dock exposes a mobile-safe Note review surface and all product decisions", async () => {
  const dock = await readFile(new URL("../src/client/LifeosDock.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/client/styles.ts", import.meta.url), "utf8");
  assert.match(dock, /data-testid="lifeos-note-candidate"/);
  assert.match(dock, /data-testid="lifeos-confirm-note"/);
  assert.match(dock, /data-testid="lifeos-request-note-revision"/);
  assert.match(dock, /data-testid="lifeos-reject-note"/);
  assert.match(styles, /@media\(max-width:600px\)[\s\S]*\.lifeos-note-content/);
});

test("bundle patch makes Chat workflow the only enabled product model route", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /id: agent-default-model[\s\S]*provider: lifeos[\s\S]*model: workflow/);
  assert.match(patch, /id: llm-deepseek[\s\S]*disabled: true/);
  assert.match(patch, /id: llm-pi-ai[\s\S]*disabled: true/);
  assert.equal((patch.match(/id: lifeos-bridge/g) ?? []).length, 1);
  assert.equal((patch.match(/name:\s*["']?@chat\/dsh-lifeos-bridge["']?/g) ?? []).length, 1);
  assert.doesNotMatch(patch, /process\.env|CHAT_(?:API_BASE_URL|DSH_STATE_PATH|REPO_ROOT)/);
});

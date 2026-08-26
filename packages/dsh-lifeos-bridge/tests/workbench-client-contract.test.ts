import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("DSH Client用公开加法Slot承载隔离且不卸载的Hosted Workbench", async () => {
  const [client, surface, manifestText] = await Promise.all([
    readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/CodeWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as {
    devDependencies?: Record<string, string>;
  };

  // 2个公开Sidebar注册（Project、Workbench），每个在name与inject处各出现一次。
  assert.equal((client.match(/sidebar\.footer\.action/g) ?? []).length, 4);
  assert.doesNotMatch(client, /lifeos-project-bootstrap/u);
  assert.match(client, /lifeos-project-management/u);
  assert.doesNotMatch(client, /conversation\.session\.header\.actions/u);
  assert.match(client, /shell\.overlay/u);
  assert.match(surface, /@deepseek-ai\/dsh-client-ui-sidebar\/client/u);
  assert.match(surface, /PropsRuntime<"sidebar\.footer\.action">/u);
  assert.match(surface, /wide \? <span>Workbench<\/span> : null/u);
  assert.equal(manifest.devDependencies?.["@deepseek-ai/dsh-client-ui-sidebar"], "0.1.0-rc.6");
  assert.match(surface, /http:\/\/localhost:43110\/workbench\/code\//u);
  assert.match(surface, /rel="noopener"/u);
  assert.doesNotMatch(surface, /noreferrer|sandbox=/u);
  assert.match(surface, /activated\s*\?/u);
  assert.match(surface, /data-open=\{state\.open/u);
});

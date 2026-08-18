import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDshPluginRegistry,
  checkDshPluginUpdates,
  defaultRepoRoot,
  loadDshPluginRegistry,
} from "./plugin-registry.mjs";

test("DSH插件登记表与workspace、安装工件及pnpm lock一致", () => {
  const root = defaultRepoRoot();
  const loaded = loadDshPluginRegistry(root);
  assert.equal(loaded.registry.plugins.length, 2);
  assert.deepEqual(
    loaded.registry.plugins.map((plugin) => plugin.id),
    ["lifeos-bridge", "mobile-hanui"],
  );
  const verified = assertDshPluginRegistry(root);
  assert.equal(verified.dshVersion, "0.1.0-rc.6");
  assert.deepEqual(
    verified.plugins.map((plugin) => plugin.source),
    ["workspace", "npm"],
  );
});

test("上游版本检查只在人工命令触发并返回候选证据", async () => {
  const calls = [];
  const current = loadDshPluginRegistry(defaultRepoRoot()).registry.plugins.find(
    (plugin) => plugin.id === "mobile-hanui",
  );
  const results = await checkDshPluginUpdates(defaultRepoRoot(), async (url) => {
    calls.push(url);
    const isCurrent = url.endsWith("/0.2.4");
    return {
      ok: true,
      async json() {
        return isCurrent
          ? {
              version: current.source.version,
              gitHead: current.source.gitHead,
              dist: {
                integrity: current.source.integrity,
                shasum: current.source.shasum,
              },
            }
          : {
              version: "0.2.5",
              gitHead: "new-head",
              dist: { integrity: "sha512-new" },
            };
      },
    };
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /dsh-mobile-hanui.*0\.2\.4/u);
  assert.match(calls[1], /dsh-mobile-hanui.*latest/u);
  assert.deepEqual(results, [
    {
      id: "mobile-hanui",
      packageName: "dsh-mobile-hanui",
      current: "0.2.4",
      latest: "0.2.5",
      updateAvailable: true,
      gitHead: "new-head",
      integrity: "sha512-new",
    },
  ]);
});

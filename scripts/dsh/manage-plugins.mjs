#!/usr/bin/env node
import {
  assertDshPluginRegistry,
  checkDshPluginUpdates,
  defaultRepoRoot,
  loadDshPluginRegistry,
} from "./plugin-registry.mjs";

const command = process.argv[2];
const root = defaultRepoRoot();

if (command === "list") {
  const { registry } = loadDshPluginRegistry(root);
  for (const plugin of registry.plugins) {
    console.log(
      [
        plugin.id,
        plugin.packageName,
        `${plugin.source.kind}:${plugin.source.version}`,
        `owner=${plugin.ownership}`,
        `adoption=${plugin.adoption}`,
        `update=${plugin.update.trigger}`,
      ].join("\t"),
    );
  }
} else if (command === "verify") {
  const result = assertDshPluginRegistry(root);
  console.log(
    `[dsh-plugins] verified ${String(result.plugins.length)} plugins for DSH ${result.dshVersion}`,
  );
} else if (command === "check-updates") {
  const results = await checkDshPluginUpdates(root);
  for (const result of results) {
    console.log(
      `${result.packageName}: current=${result.current} latest=${result.latest} update=${result.updateAvailable ? "available" : "none"}`,
    );
  }
} else {
  console.error("用法: node scripts/dsh/manage-plugins.mjs <list|verify|check-updates>");
  process.exitCode = 2;
}

import { glob } from "node:fs/promises";
import process from "node:process";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const files = [];
for await (const file of glob("src/**/*.test.mjs")) files.push(file);
files.push("scripts/deployment-config.test.mjs");
files.sort();

const tests = run({ files });
tests.on("test:fail", () => {
  process.exitCode = 1;
});
tests.compose(spec()).pipe(process.stdout);

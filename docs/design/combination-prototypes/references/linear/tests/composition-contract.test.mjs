import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("embedded bootstrap preserves reference context and accepts parent routes", async () => {
  const source = await read("../src/main.jsx");
  assert.match(source, /dataset\.reference = "linear"/);
  assert.match(source, /dataset\.theme = query\.get\("theme"\) \|\| "source"/);
  assert.match(source, /event\.data\?\.type !== "chat:route"/);
  assert.match(source, /history\.pushState/);
  assert.match(source, /new PopStateEvent\("popstate"/);
  for (const key of ["composition", "embedded", "theme"]) assert.equal(source.includes(`"${key}"`), true);
});

test("room-basecamp removes Linear Issues while Linear-owned modes retain them", async () => {
  const source = await read("../src/App.jsx");
  assert.match(source, /compositionMode\(\) === "room-basecamp"/);
  assert.match(source, /basecampOwnsWork\(\) && isLinearIssueRoute/);
  assert.match(source, /\{!basecampOwnsWork\(\) && <button/);
  assert.match(source, /navigate\(\{ view: "issues", issueId: route\.issueId \}\)/);
  assert.match(source, /postHostRoute\("work"/);
  assert.match(source, /\{ type: "chat:route", scene, url:/);
  assert.match(source, /combinationModes\.has\(compositionMode\(\)\) && isProjectIssuesRoute/);
});

test("Project Issues tab delegates to the one canonical Work scene", async () => {
  const source = await read("../src/App.jsx");
  assert.match(source, /id === "issues" && combinationModes\.has\(compositionMode\(\)\) \? postHostRoute\("work"/);
});

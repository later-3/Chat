import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoDuplicateOwners,
  compositions,
  sceneCatalog,
  sourceCatalog,
} from "../src/model.js";

const capabilities = Object.values(sceneCatalog).map((scene) => scene.capability);

test("three compositions come from real overlap ownership, not arbitrary new UI", () => {
  assert.deepEqual(
    compositions.map((composition) => composition.id),
    ["room-linear", "room-basecamp", "work-linear"],
  );
  assert.deepEqual(
    compositions.map((composition) => composition.rank),
    [1, 2, 3],
  );
});

test("every composition is a complete app with exactly one owner per capability", () => {
  for (const composition of compositions) {
    assert.equal(assertNoDuplicateOwners(composition), true);
    assert.deepEqual(Object.keys(composition.ownership).sort(), [...capabilities].sort());
    assert.deepEqual(Object.keys(composition.scenes).sort(), Object.keys(sceneCatalog).sort());
    for (const scene of Object.values(composition.scenes)) {
      assert.ok(sourceCatalog[scene.source], `${composition.id} uses a registered reference source`);
    }
  }
});

test("the three variants differ only where Basecamp and Linear genuinely overlap", () => {
  const [roomLinear, roomBasecamp, workLinear] = compositions;
  assert.equal(roomLinear.ownership.work_execution, "linear");
  assert.equal(roomBasecamp.ownership.work_execution, "basecamp");
  assert.equal(workLinear.ownership.work_execution, "linear");
  assert.equal(roomLinear.ownership.project_portfolio, "basecamp");
  assert.equal(roomBasecamp.ownership.project_portfolio, "basecamp");
  assert.equal(workLinear.ownership.project_portfolio, "linear");
  for (const capability of ["today_actions", "calendar_events", "agent_supervision", "knowledge_workbench"]) {
    assert.equal(new Set(compositions.map((composition) => composition.ownership[capability])).size, 1);
  }
});

test("Action, Event, Agent supervision, and Knowledge remain non-overlapping source chains", () => {
  for (const composition of compositions) {
    assert.equal(composition.scenes.today.source, "things");
    assert.equal(composition.scenes.calendar.source, "hey");
    assert.equal(composition.scenes.agents.source, "agent-feed");
    assert.equal(composition.scenes.knowledge.source, "heptabase");
    assert.notEqual(composition.scenes.today.source, composition.scenes.calendar.source);
  }
});

test("each frozen reference appears as an explicit implementation source", () => {
  assert.deepEqual(Object.keys(sourceCatalog), ["basecamp", "linear", "things", "hey", "agent-feed", "heptabase"]);
  for (const source of Object.values(sourceCatalog)) assert.match(source.path, /^\/references\//);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  beginEmailEventDraft,
  beginEventDraft,
  conflictsForDraft,
  createInitialState,
  editEventDraft,
  eventsForDate,
  saveEventDraft,
  searchCalendar,
  shiftEventDraft,
  todayIso,
  yearEvents,
} from "../src/heyModel.js";

test("HEY keeps Day, Week, Year, candidate, conflict, and save as one Event model", () => {
  const initial = createInitialState();
  assert.equal(Object.hasOwn(initial, "tasks"), false);
  assert.deepEqual(yearEvents(initial, 2026).map((event) => event.id).sort(), [
    "event-break",
    "event-copenhagen",
    "event-offsite",
  ]);

  const candidate = beginEmailEventDraft(initial, todayIso);
  assert.equal(candidate.events.length, initial.events.length);
  assert.equal(candidate.draftEvent.source.type, "email");
  assert.deepEqual(conflictsForDraft(candidate).map((event) => event.id), ["event-client"]);

  const shifted = shiftEventDraft(candidate, 120);
  assert.equal(shifted.draftEvent.start, "14:00");
  assert.equal(shifted.draftEvent.end, "15:00");

  const saved = saveEventDraft(shifted);
  const created = saved.events.find((event) => event.id === "event-created-1");
  assert.ok(created);
  assert.strictEqual(eventsForDate(saved, todayIso).find((event) => event.id === created.id), created);
});

test("editing saves one stable Event and calendar search has no task result type", () => {
  const initial = createInitialState();
  const editing = editEventDraft(beginEventDraft(initial, todayIso, "event-client"), {
    title: "Client review updated",
  });
  const saved = saveEventDraft(editing);
  assert.equal(saved.events.length, initial.events.length);
  assert.equal(saved.events.find((event) => event.id === "event-client").title, "Client review updated");
  assert.equal(searchCalendar(saved, "client")[0].type, "Event");
  assert.equal(searchCalendar(saved, "gift").length, 0);
});

test("the HEY reference exposes no duplicate Sometime or add-task surface", async () => {
  const [app, model, main, themes] = await Promise.all([
    readFile(new URL("../src/App.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/heyModel.js", import.meta.url), "utf8"),
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/theme-overrides.css", import.meta.url), "utf8"),
  ]);
  for (const token of ["DayView", "WeekView", "YearView", "EventComposer", "MiniSchedule"]) {
    assert.ok(app.includes(token), `missing HEY interaction: ${token}`);
  }
  for (const token of ["SometimeStrip", "AddTaskDialog", "taskOpen", "toggleTask", "addTask"]) {
    assert.equal(app.includes(token) || model.includes(token), false, `duplicate task surface remains: ${token}`);
  }
  assert.ok(main.includes('event.data?.type !== "chat:route"'));
  assert.ok(main.includes('new PopStateEvent("popstate"'));
  assert.ok(main.includes('new HashChangeEvent("hashchange"'));
  assert.match(main, /import "\.\/styles\.css";\s*import "\.\/theme-overrides\.css";/);
  for (const theme of ["warm-room", "quiet-day", "graphite-ops", "common-thread"]) {
    assert.ok(themes.includes(`[data-theme="${theme}"]`), `missing HEY theme: ${theme}`);
  }
  assert.equal(themes.includes('[data-theme="source"]'), false);
});

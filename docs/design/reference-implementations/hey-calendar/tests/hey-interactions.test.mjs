import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  addTask,
  beginEmailEventDraft,
  beginEventDraft,
  conflictsForDraft,
  createInitialState,
  editEventDraft,
  eventsForDate,
  saveEventDraft,
  saveJournal,
  searchCalendar,
  shiftEventDraft,
  todayIso,
  toggleCalendar,
  toggleHabit,
  toggleTask,
  updateDecoration,
  visibleEvents,
  yearEvents,
} from "../src/heyModel.js";

test("calendar owns color while events only reference a calendar", () => {
  const state = createInitialState();
  assert.equal(state.calendars.length, 4);
  assert.ok(state.calendars.every((calendar) => calendar.color));
  assert.ok(state.events.every((event) => !Object.hasOwn(event, "color")));
});

test("Day and visible calendar projections preserve event identity", () => {
  const state = createInitialState();
  const event = state.events.find((item) => item.id === "event-client");
  assert.strictEqual(eventsForDate(state, todayIso).find((item) => item.id === event.id), event);
  assert.strictEqual(visibleEvents(state).find((item) => item.id === event.id), event);
});

test("Year contains only all-day or multi-day events", () => {
  const state = createInitialState();
  const events = yearEvents(state, 2026);
  assert.deepEqual(events.map((event) => event.id).sort(), ["event-break", "event-copenhagen", "event-offsite"]);
  assert.ok(events.every((event) => event.allDay || event.endDate !== event.date));
});

test("email creates a separate candidate with source provenance", () => {
  const initial = createInitialState();
  const next = beginEmailEventDraft(initial, todayIso);
  assert.equal(initial.draftEvent, null);
  assert.equal(next.events.length, initial.events.length);
  assert.equal(next.draftEvent.source.type, "email");
  assert.equal(next.draftEvent.title, "Lunch with Tim");
});

test("candidate detects a conflict and shifting preserves duration", () => {
  const conflicted = beginEmailEventDraft(createInitialState(), todayIso);
  assert.deepEqual(conflictsForDraft(conflicted).map((event) => event.id), ["event-client"]);
  const shifted = shiftEventDraft(conflicted, 120);
  assert.equal(shifted.draftEvent.start, "14:00");
  assert.equal(shifted.draftEvent.end, "15:00");
});

test("saving a candidate creates one stable event reflected in projections", () => {
  const draft = editEventDraft(beginEventDraft(createInitialState(), todayIso), { title: "Saved prototype event" });
  const saved = saveEventDraft(draft);
  const created = saved.events.find((event) => event.id === "event-created-1");
  assert.ok(created);
  assert.strictEqual(eventsForDate(saved, todayIso).find((event) => event.id === created.id), created);
  assert.equal(saved.draftEvent, null);
});

test("editing updates the same event id instead of duplicating it", () => {
  const initial = createInitialState();
  const edited = editEventDraft(beginEventDraft(initial, todayIso, "event-client"), { title: "Client review updated" });
  const saved = saveEventDraft(edited);
  assert.equal(saved.events.length, initial.events.length);
  assert.equal(saved.events.find((event) => event.id === "event-client").title, "Client review updated");
});

test("calendar visibility affects Day and Search without deleting events", () => {
  const initial = createInitialState();
  const hidden = toggleCalendar(initial, "work");
  assert.equal(hidden.events.length, initial.events.length);
  assert.equal(eventsForDate(hidden, todayIso).some((event) => event.calendarId === "work"), false);
  assert.equal(searchCalendar(hidden, "client").length, 0);
});

test("Search returns events, Sometime tasks, and Journal", () => {
  const state = createInitialState();
  assert.equal(searchCalendar(state, "client")[0].type, "Event");
  assert.equal(searchCalendar(state, "gift")[0].type, "Sometime");
  assert.equal(searchCalendar(state, "interaction decisions")[0].type, "Journal");
});

test("Sometime, Habits, Journal, and Day decoration remain independent", () => {
  const initial = createInitialState();
  const task = toggleTask(addTask(initial, "Pack notebook"), "task-created-1");
  const habit = toggleHabit(task, "habit-walk", todayIso);
  const journal = saveJournal(habit, todayIso, "A revised journal note.");
  const decorated = updateDecoration(journal, todayIso, { name: "Reference day", circled: false });
  assert.equal(decorated.tasks.at(-1).completed, true);
  assert.ok(decorated.habits.find((item) => item.id === "habit-walk").completedDates.includes(todayIso));
  assert.equal(decorated.journals[todayIso], "A revised journal note.");
  assert.deepEqual(decorated.decorations[todayIso], { name: "Reference day", circled: false });
  assert.equal(decorated.events.length, initial.events.length);
});

test("JSX exposes the three views, core dialogs, and keyboard routes", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  for (const token of ["DayView", "WeekView", "YearView", "EventComposer", "SearchDialog", "JournalDialog", "HabitsDialog", "AddTaskDialog", 'normalized === "d"', 'normalized === "u"', 'normalized === "y"', 'normalized === "n"']) {
    assert.ok(source.includes(token), `missing interaction contract: ${token}`);
  }
  assert.equal((source.match(/onClick=\{\(\) => \{\}\}/g) || []).length, 0);
});

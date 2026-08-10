const DAY_MS = 86_400_000;

export const todayIso = "2026-08-09";

export const calendarSources = [
  { id: "personal", name: "Personal", color: "#3184e8", visible: true },
  { id: "work", name: "Work", color: "#6550d8", visible: true },
  { id: "family", name: "Family", color: "#50a86d", visible: true },
  { id: "maybe", name: "Maybe", color: "#9a8b54", visible: true, tentative: true },
];

const seedEvents = [
  { id: "event-focus", calendarId: "personal", title: "Morning focus", date: todayIso, endDate: todayIso, start: "08:30", end: "10:00", allDay: false, location: "Studio", notification: "15 minutes before", notes: "Protect this block for the interaction prototype.", attendees: [], repeat: "Never", countdown: false, circled: false, source: null },
  { id: "event-client", calendarId: "work", title: "Client review", date: todayIso, endDate: todayIso, start: "12:00", end: "13:30", allDay: false, location: "Zoom", notification: "30 minutes before", notes: "Review the current prototype and unresolved edge cases.", attendees: ["alex@northstar.example"], repeat: "Never", countdown: false, circled: false, source: null },
  { id: "event-lunch", calendarId: "family", title: "Lunch with Mei", date: todayIso, endDate: todayIso, start: "13:30", end: "14:30", allDay: false, location: "Mercado", notification: "15 minutes before", notes: "", attendees: [], repeat: "Never", countdown: false, circled: false, source: null },
  { id: "event-critique", calendarId: "work", title: "Design critique", date: todayIso, endDate: todayIso, start: "15:00", end: "16:00", allDay: false, location: "Project room", notification: "10 minutes before", notes: "Bring the Day / Week comparison.", attendees: ["sara@northstar.example"], repeat: "Every week", countdown: false, circled: false, source: null },
  { id: "event-call", calendarId: "family", title: "Family call", date: todayIso, endDate: todayIso, start: "17:30", end: "18:00", allDay: false, location: "FaceTime", notification: "10 minutes before", notes: "", attendees: [], repeat: "Every week", countdown: false, circled: false, source: null },
  { id: "event-softball", calendarId: "personal", title: "Softball league", date: todayIso, endDate: todayIso, start: "19:00", end: "21:00", allDay: false, location: "Riverside field", notification: "30 minutes before", notes: "", attendees: [], repeat: "Every week", countdown: false, circled: false, source: null },
  { id: "event-gym", calendarId: "family", title: "Gym", date: "2026-08-10", endDate: "2026-08-10", start: "09:00", end: "10:00", allDay: false, location: "North Loop", notification: "None", notes: "", attendees: [], repeat: "Every week", countdown: false, circled: false, source: null },
  { id: "event-workshop", calendarId: "work", title: "Research workshop", date: "2026-08-11", endDate: "2026-08-11", start: "14:00", end: "16:00", allDay: false, location: "Lab 3", notification: "30 minutes before", notes: "", attendees: [], repeat: "Never", countdown: false, circled: false, source: null },
  { id: "event-maybe", calendarId: "maybe", title: "Maybe: gallery opening", date: "2026-08-12", endDate: "2026-08-12", start: "18:30", end: "20:00", allDay: false, location: "Mason Street", notification: "None", notes: "Tentative.", attendees: [], repeat: "Never", countdown: false, circled: false, source: null },
  { id: "event-offsite", calendarId: "work", title: "Northstar offsite", date: "2026-08-13", endDate: "2026-08-15", start: "00:00", end: "23:59", allDay: true, location: "Napa", notification: "1 day before", notes: "", attendees: [], repeat: "Never", countdown: true, circled: true, source: null },
  { id: "event-break", calendarId: "family", title: "Autumn break", date: "2026-10-03", endDate: "2026-10-10", start: "00:00", end: "23:59", allDay: true, location: "", notification: "1 day before", notes: "", attendees: [], repeat: "Never", countdown: true, circled: false, source: null },
  { id: "event-copenhagen", calendarId: "personal", title: "Copenhagen", date: "2026-11-12", endDate: "2026-11-18", start: "00:00", end: "23:59", allDay: true, location: "Copenhagen", notification: "1 day before", notes: "", attendees: [], repeat: "Never", countdown: true, circled: false, source: null },
];

const seedHabits = [
  { id: "habit-walk", name: "Morning walk", icon: "walk", color: "#f1882b", completedDates: ["2026-08-08"] },
  { id: "habit-read", name: "Read 20 minutes", icon: "book", color: "#4ba875", completedDates: [todayIso] },
];

export const sourceMessage = {
  id: "message-lunch",
  subject: "Lunch next week?",
  sender: "Tim Smith",
  excerpt: "I will be in town and wondered if you would be free to catch up over lunch.",
  privateLink: "hey://message/message-lunch",
};

export function createInitialState() {
  return {
    calendars: calendarSources.map((calendar) => ({ ...calendar })),
    events: seedEvents.map((event) => ({ ...event, attendees: [...event.attendees] })),
    habits: seedHabits.map((habit) => ({ ...habit, completedDates: [...habit.completedDates] })),
    journals: { [todayIso]: "Capture the interaction decisions before the afternoon critique." },
    decorations: { [todayIso]: { name: "Prototype Sunday", circled: true } },
    draftEvent: null,
    nextEventSequence: 1,
  };
}

export function addDays(dateIso, offset) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  return new Date(date.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

export function startOfWeek(dateIso) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  return addDays(dateIso, -date.getUTCDay());
}

export function weekDates(dateIso) {
  const start = startOfWeek(dateIso);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function minutesFromTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function timeFromMinutes(value) {
  const bounded = Math.max(0, Math.min(23 * 60 + 59, value));
  const hours = Math.floor(bounded / 60);
  const minutes = bounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function calendarById(state, calendarId) {
  return state.calendars.find((calendar) => calendar.id === calendarId);
}

export function eventById(state, eventId) {
  return state.events.find((event) => event.id === eventId);
}

export function eventTouchesDate(event, dateIso) {
  return event.date <= dateIso && event.endDate >= dateIso;
}

export function visibleEvents(state) {
  const visibleIds = new Set(state.calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id));
  return state.events.filter((event) => visibleIds.has(event.calendarId));
}

export function eventsForDate(state, dateIso) {
  return visibleEvents(state)
    .filter((event) => eventTouchesDate(event, dateIso))
    .sort((left, right) => left.allDay === right.allDay ? left.start.localeCompare(right.start) : left.allDay ? -1 : 1);
}

export function yearEvents(state, year) {
  return visibleEvents(state).filter((event) => event.date.startsWith(String(year)) && (event.allDay || event.endDate !== event.date));
}

function blankDraft(dateIso) {
  return {
    id: null,
    calendarId: "personal",
    title: "",
    date: dateIso,
    endDate: dateIso,
    start: "11:00",
    end: "12:00",
    allDay: false,
    location: "",
    notification: "30 minutes before",
    notes: "",
    attendees: [],
    repeat: "Never",
    countdown: false,
    circled: false,
    source: null,
  };
}

export function beginEventDraft(state, dateIso, eventId = null) {
  const event = eventId ? eventById(state, eventId) : null;
  return {
    ...state,
    draftEvent: event ? { ...event, attendees: [...event.attendees] } : blankDraft(dateIso),
  };
}

export function beginEmailEventDraft(state, dateIso = todayIso) {
  return {
    ...state,
    draftEvent: {
      ...blankDraft(dateIso),
      calendarId: "work",
      title: "Lunch with Tim",
      start: "12:00",
      end: "13:00",
      location: "Perilla, Chicago",
      attendees: ["tim@example.com"],
      source: { type: "email", id: sourceMessage.id, label: sourceMessage.subject, privateLink: sourceMessage.privateLink },
    },
  };
}

export function editEventDraft(state, patch) {
  if (!state.draftEvent) return state;
  const next = { ...state.draftEvent, ...patch };
  if (patch.date && !Object.hasOwn(patch, "endDate")) next.endDate = patch.date;
  return { ...state, draftEvent: next };
}

export function shiftEventDraft(state, deltaMinutes) {
  if (!state.draftEvent || state.draftEvent.allDay) return state;
  const duration = Math.max(15, minutesFromTime(state.draftEvent.end) - minutesFromTime(state.draftEvent.start));
  const start = Math.max(0, Math.min(23 * 60 + 59 - duration, minutesFromTime(state.draftEvent.start) + deltaMinutes));
  return editEventDraft(state, { start: timeFromMinutes(start), end: timeFromMinutes(start + duration) });
}

export function placeEventDraft(state, startMinutes) {
  if (!state.draftEvent || state.draftEvent.allDay) return state;
  const duration = Math.max(15, minutesFromTime(state.draftEvent.end) - minutesFromTime(state.draftEvent.start));
  const start = Math.max(0, Math.min(23 * 60 + 59 - duration, startMinutes));
  return editEventDraft(state, { start: timeFromMinutes(start), end: timeFromMinutes(start + duration) });
}

export function conflictsForDraft(state) {
  const draft = state.draftEvent;
  if (!draft || draft.allDay) return [];
  const start = minutesFromTime(draft.start);
  const end = minutesFromTime(draft.end);
  return state.events.filter((event) => event.id !== draft.id && !event.allDay && event.date === draft.date && minutesFromTime(event.start) < end && minutesFromTime(event.end) > start);
}

export function canSaveDraft(state) {
  const draft = state.draftEvent;
  return Boolean(draft?.title.trim() && calendarById(state, draft.calendarId) && (draft.allDay || minutesFromTime(draft.end) > minutesFromTime(draft.start)));
}

export function saveEventDraft(state) {
  if (!canSaveDraft(state)) return state;
  const draft = { ...state.draftEvent, title: state.draftEvent.title.trim(), attendees: [...state.draftEvent.attendees] };
  if (draft.id) {
    return { ...state, events: state.events.map((event) => event.id === draft.id ? draft : event), draftEvent: null };
  }
  const saved = { ...draft, id: `event-created-${state.nextEventSequence}` };
  return { ...state, events: [...state.events, saved], draftEvent: null, nextEventSequence: state.nextEventSequence + 1 };
}

export function discardEventDraft(state) {
  return state.draftEvent ? { ...state, draftEvent: null } : state;
}

export function toggleCalendar(state, calendarId) {
  return { ...state, calendars: state.calendars.map((calendar) => calendar.id === calendarId ? { ...calendar, visible: !calendar.visible } : calendar) };
}

export function toggleHabit(state, habitId, dateIso) {
  return {
    ...state,
    habits: state.habits.map((habit) => {
      if (habit.id !== habitId) return habit;
      const completed = new Set(habit.completedDates);
      if (completed.has(dateIso)) completed.delete(dateIso);
      else completed.add(dateIso);
      return { ...habit, completedDates: [...completed].sort() };
    }),
  };
}

export function saveJournal(state, dateIso, body) {
  return { ...state, journals: { ...state.journals, [dateIso]: body } };
}

export function updateDecoration(state, dateIso, patch) {
  return { ...state, decorations: { ...state.decorations, [dateIso]: { name: "", circled: false, ...state.decorations[dateIso], ...patch } } };
}

export function searchCalendar(state, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const eventResults = visibleEvents(state)
    .filter((event) => [event.title, event.location, event.notes, ...event.attendees].join(" ").toLowerCase().includes(needle))
    .map((event) => ({ id: event.id, type: "Event", title: event.title, date: event.date, object: event }));
  const journalResults = Object.entries(state.journals)
    .filter(([, body]) => body.toLowerCase().includes(needle))
    .map(([date, body]) => ({ id: `journal-${date}`, type: "Journal", title: body, date, object: body }));
  return [...eventResults, ...journalResults];
}

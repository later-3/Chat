import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsLeftRight,
  Bell,
  BookOpen,
  CalendarBlank,
  CalendarDots,
  CaretDown,
  Check,
  CheckCircle,
  Circle,
  Clock,
  EnvelopeSimple,
  Footprints,
  Image,
  LinkSimple,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  MoonStars,
  Notebook,
  Plus,
  Repeat,
  SquaresFour,
  UserPlus,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  addDays,
  beginEmailEventDraft,
  beginEventDraft,
  calendarById,
  canSaveDraft,
  conflictsForDraft,
  createInitialState,
  discardEventDraft,
  editEventDraft,
  eventsForDate,
  minutesFromTime,
  placeEventDraft,
  saveEventDraft,
  saveJournal,
  searchCalendar,
  shiftEventDraft,
  sourceMessage,
  startOfWeek,
  todayIso,
  toggleCalendar,
  toggleHabit,
  updateDecoration,
  weekDates,
  yearEvents,
} from "./heyModel.js";

const views = new Set(["day", "week", "year"]);
const hourWidth = 76;
const dayStartHour = 0;

function readRoute() {
  const params = new URLSearchParams(window.location.search);
  return {
    view: views.has(params.get("view")) ? params.get("view") : "day",
    date: /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : todayIso,
  };
}

function routeUrl(route) {
  const url = new URL(window.location.href);
  const preserved = new URLSearchParams(window.location.search);
  url.search = "";
  for (const key of ["embedded", "theme", "composition", "scene"]) {
    const value = preserved.get(key);
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("view", route.view);
  url.searchParams.set("date", route.date);
  return url;
}

function dateObject(dateIso) {
  return new Date(`${dateIso}T12:00:00Z`);
}

function formatLongDate(dateIso) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(dateObject(dateIso));
}

function formatShortDate(dateIso) {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(dateObject(dateIso));
}

function formatWeekLabel(dateIso) {
  const dates = weekDates(dateIso);
  const first = dateObject(dates[0]);
  const last = dateObject(dates[6]);
  const firstText = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(first);
  const lastText = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(last);
  return `${firstText} – ${lastText}`;
}

function formatTime(time) {
  const [hour, minute] = time.split(":").map(Number);
  const suffix = hour >= 12 ? "pm" : "am";
  const normalized = hour % 12 || 12;
  return `${normalized}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${suffix}`;
}

function Avatar() {
  return <img className="avatar" src="/assets/hey/profile-avatar.png" alt="Maya Chen" />;
}

function AppHeader({ route, navigate, onMenu, onNew, onSearch }) {
  const changeView = (view) => navigate({ ...route, view });
  return (
    <header className="app-header">
      <div className="header-left">
        <button type="button" className="app-grid" aria-label="Open HEY menu" onClick={onMenu}><SquaresFour size={21} weight="fill" /></button>
        <nav className="view-switcher" aria-label="Calendar view">
          {["day", "week", "year"].map((view) => <button type="button" key={view} className={route.view === view ? "is-active" : ""} aria-pressed={route.view === view} onClick={() => changeView(view)}>{view[0].toUpperCase() + view.slice(1)}</button>)}
        </nav>
        <button type="button" className="new-event" aria-label="New event" onClick={onNew}><Plus size={24} weight="bold" /></button>
      </div>
      <button type="button" className="brand" aria-label="HEY Calendar home" onClick={() => navigate({ view: "day", date: todayIso })}><EnvelopeSimple size={27} /><CalendarDots size={28} weight="fill" /><strong>HEY</strong><CaretDown size={15} weight="bold" /></button>
      <div className="header-right">
        <button type="button" className="icon-action" aria-label="Search calendar" onClick={onSearch}><MagnifyingGlass size={22} weight="bold" /></button>
        <Avatar />
      </div>
    </header>
  );
}

function DateNavigation({ route, navigate }) {
  const offset = route.view === "week" ? 7 : route.view === "year" ? 365 : 1;
  return (
    <div className="date-navigation">
      <button type="button" onClick={() => navigate({ ...route, date: todayIso })}>Today</button>
      <div>
        <button type="button" aria-label={`Previous ${route.view}`} onClick={() => navigate({ ...route, date: addDays(route.date, -offset) })}><ArrowLeft size={21} weight="bold" /></button>
        <button type="button" aria-label={`Next ${route.view}`} onClick={() => navigate({ ...route, date: addDays(route.date, offset) })}><ArrowRight size={21} weight="bold" /></button>
      </div>
    </div>
  );
}

function CalendarMenu({ state, setState, date, onClose, onJournal, onHabits }) {
  const decoration = state.decorations[date] || { name: "", circled: false };
  return (
    <div className="menu-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="calendar-menu" role="dialog" aria-modal="true" aria-label="HEY menu">
        <header><div><CalendarDots size={22} weight="fill" /><strong>Calendars</strong></div><button type="button" aria-label="Close HEY menu" onClick={onClose}><X size={19} /></button></header>
        <div className="calendar-toggles">
          {state.calendars.map((calendar) => <label key={calendar.id}><input type="checkbox" checked={calendar.visible} onChange={() => setState((current) => toggleCalendar(current, calendar.id))} /><span className="calendar-dot" style={{ "--calendar-color": calendar.color }} /><span><strong>{calendar.name}</strong><small>{calendar.tentative ? "Tentative events use a hatched treatment" : "Visible in Day, Week, Year, and Search"}</small></span></label>)}
        </div>
        <label className="day-name-field">
          <span>Name this day</span>
          <input value={decoration.name} placeholder="Add a memorable label" onChange={(event) => setState((current) => updateDecoration(current, date, { name: event.target.value }))} />
          <small>Personal to this date and separate from its events.</small>
        </label>
        <div className="menu-actions">
          <button type="button" onClick={onJournal}><Notebook size={19} /><span><strong>Journal</strong><small>Notes attached to {formatShortDate(date)}</small></span></button>
          <button type="button" onClick={onHabits}><Footprints size={19} /><span><strong>Habits</strong><small>Personal practice, separate from events</small></span></button>
          <button type="button" onClick={() => setState((current) => updateDecoration(current, date, { circled: !decoration.circled }))}><Circle size={19} weight={decoration.circled ? "fill" : "regular"} /><span><strong>{decoration.circled ? "Remove day circle" : "Circle this day"}</strong><small>Only changes your personal calendar view</small></span></button>
        </div>
      </section>
    </div>
  );
}

function EventButton({ state, event, onOpen, className = "" }) {
  const calendar = calendarById(state, event.calendarId);
  const scheduleLabel = event.allDay ? "All day" : `${formatTime(event.start)} to ${formatTime(event.end)}`;
  return (
    <button type="button" className={`event-block ${calendar.tentative ? "is-tentative" : ""} ${className}`} style={{ "--event-color": calendar.color }} onClick={() => onOpen(event.id)} aria-label={`${event.title}, ${scheduleLabel}, ${calendar.name}`}>
      <span>{event.title}</span><small>{event.allDay ? "All day" : `${formatTime(event.start)}–${formatTime(event.end)}`}</small>
    </button>
  );
}

function HabitRail({ state, setState, date, onOpen }) {
  return (
    <div className="habit-rail" aria-label="Habits">
      {state.habits.map((habit) => {
        const complete = habit.completedDates.includes(date);
        return <button type="button" key={habit.id} aria-pressed={complete} onClick={() => setState((current) => toggleHabit(current, habit.id, date))} style={{ "--habit-color": habit.color }}><span>{complete ? <Check size={14} weight="bold" /> : <Footprints size={15} />}</span>{habit.name}</button>;
      })}
      <button type="button" className="habit-settings" onClick={onOpen}>Manage</button>
    </div>
  );
}

function DayTimeline({ state, date, onOpenEvent, onNewAt }) {
  const scroller = useRef(null);
  const events = eventsForDate(state, date).filter((event) => !event.allDay);
  useEffect(() => { if (scroller.current) scroller.current.scrollLeft = Math.max(0, (7 - dayStartHour) * hourWidth - 120); }, [date]);
  const hours = Array.from({ length: 24 }, (_, index) => index);
  return (
    <>
      <div className="day-timeline" ref={scroller} aria-label={`Timeline for ${formatLongDate(date)}`}>
        <div className="timeline-track" style={{ "--hour-width": `${hourWidth}px` }}>
          <div className="night-band night-band--morning" aria-label="Nighttime, midnight to 6am"><span><MoonStars size={17} />Nighttime</span></div>
          <div className="night-band night-band--evening" aria-label="Nighttime, 10pm to midnight"><span><MoonStars size={17} />Nighttime</span></div>
          <div className="hour-labels">{hours.map((hour) => <button type="button" key={hour} onClick={() => onNewAt(hour * 60)} aria-label={`Create event at ${formatTime(`${String(hour).padStart(2, "0")}:00`)}`}><span>{formatTime(`${String(hour).padStart(2, "0")}:00`)}</span></button>)}</div>
          <div className="now-line" style={{ left: `${(15.35 - dayStartHour) * hourWidth}px` }}><Clock size={16} weight="fill" /><span>3:21pm</span></div>
          {events.map((event) => {
            const start = minutesFromTime(event.start) / 60;
            const end = minutesFromTime(event.end) / 60;
            return <div className="timeline-event-position" key={event.id} style={{ left: `${(start - dayStartHour) * hourWidth + 4}px`, width: `${Math.max(36, (end - start) * hourWidth - 8)}px` }}><EventButton state={state} event={event} onOpen={onOpenEvent} /></div>;
          })}
        </div>
      </div>
      <div className="mobile-agenda" aria-label={`Agenda for ${formatLongDate(date)}`}>
        {events.map((event) => <div key={event.id} className="mobile-agenda-row"><time>{formatTime(event.start)}</time><EventButton state={state} event={event} onOpen={onOpenEvent} /></div>)}
      </div>
    </>
  );
}

function DayView({ state, setState, route, navigate, onOpenEvent, onNewAt, onEmail, onJournal, onHabits, onDecorate }) {
  const events = eventsForDate(state, route.date);
  const allDay = events.filter((event) => event.allDay);
  const decoration = state.decorations[route.date] || { name: "", circled: false };
  return (
    <main className="calendar-main day-main">
      <section className={`day-title ${decoration.circled ? "is-circled" : ""}`}>
        <div><button type="button" className="day-name-action" onClick={onDecorate}>{decoration.name || "Name this day"}</button><h1>{formatLongDate(route.date)}</h1></div>
        <div className="day-context-actions"><button type="button" onClick={onJournal}><Notebook size={17} />Journal</button><button type="button" onClick={onEmail}><EnvelopeSimple size={17} />Create from message</button></div>
      </section>
      {allDay.length > 0 && <section className="all-day-row"><strong>All day</strong>{allDay.map((event) => <EventButton key={event.id} state={state} event={event} onOpen={onOpenEvent} />)}</section>}
      <DayTimeline state={state} date={route.date} onOpenEvent={onOpenEvent} onNewAt={onNewAt} />
      <HabitRail state={state} setState={setState} date={route.date} onOpen={onHabits} />
    </main>
  );
}

function WeekSection({ state, date, currentDate, onSelectDate, onOpenEvent, current = false }) {
  const dates = weekDates(date);
  return (
    <section className={`week-section ${current ? "is-current" : ""}`} aria-label={`Week of ${formatShortDate(dates[0])}`}>
      <div className="week-month">{new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(dateObject(dates[0]))}</div>
      <div className="week-days">
        {dates.map((day) => {
          const events = eventsForDate(state, day);
          const selected = day === currentDate;
          return <article key={day} className={selected ? "is-selected" : ""}><button type="button" className="week-day-heading" onClick={() => onSelectDate(day)}><span>{new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(dateObject(day))}</span><strong>{Number(day.slice(-2))}</strong></button><div className="week-events">{events.map((event) => <EventButton key={event.id} state={state} event={event} onOpen={onOpenEvent} />)}</div></article>;
        })}
      </div>
    </section>
  );
}

function WeekView({ state, route, navigate, onOpenEvent }) {
  const currentStart = startOfWeek(route.date);
  return (
    <main className="calendar-main week-main">
      <header className="view-title"><span>Seven days in sequence</span><h1>{formatWeekLabel(route.date)}</h1></header>
      <div className="week-stack">
        <WeekSection state={state} date={addDays(currentStart, -7)} currentDate={route.date} onSelectDate={(date) => navigate({ view: "day", date })} onOpenEvent={onOpenEvent} />
        <WeekSection state={state} date={currentStart} currentDate={route.date} onSelectDate={(date) => navigate({ view: "day", date })} onOpenEvent={onOpenEvent} current />
        <WeekSection state={state} date={addDays(currentStart, 7)} currentDate={route.date} onSelectDate={(date) => navigate({ view: "day", date })} onOpenEvent={onOpenEvent} />
      </div>
    </main>
  );
}

function monthDates(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const prefix = first.getUTCDay();
  return [...Array(prefix).fill(null), ...Array.from({ length: lastDay }, (_, index) => `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`)];
}

function YearView({ state, route, navigate, onOpenEvent }) {
  const year = Number(route.date.slice(0, 4));
  const spanning = yearEvents(state, year);
  return (
    <main className="calendar-main year-main">
      <header className="view-title"><span>Only all-day and multi-day events</span><h1>{year}</h1></header>
      <section className="year-grid">
        {Array.from({ length: 12 }, (_, month) => {
          const days = monthDates(year, month);
          const monthEvents = spanning.filter((event) => Number(event.date.slice(5, 7)) - 1 === month);
          return <article className="month-card" key={month}><h2>{new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month, 1)))}</h2><div className="weekday-row">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div><div className="month-days">{days.map((day, index) => day ? <button type="button" key={day} className={day === route.date ? "is-selected" : ""} onClick={() => navigate({ view: "day", date: day })}>{Number(day.slice(-2))}</button> : <span key={`empty-${index}`} />)}</div><div className="month-events">{monthEvents.map((event) => <EventButton key={event.id} state={state} event={event} onOpen={onOpenEvent} />)}</div></article>;
        })}
      </section>
    </main>
  );
}

function MiniSchedule({ state, setState }) {
  const draft = state.draftEvent;
  const conflicts = conflictsForDraft(state);
  const dateEvents = eventsForDate(state, draft.date).filter((event) => !event.allDay && event.id !== draft.id);
  const slots = [8, 10, 12, 14, 16, 18];
  return (
    <section className="mini-schedule">
      <header><div><strong>Peek at {formatShortDate(draft.date)}</strong><span>Choose a slot or adjust by 30 minutes.</span></div><div><button type="button" onClick={() => setState((current) => shiftEventDraft(current, -30))}>Earlier</button><button type="button" onClick={() => setState((current) => shiftEventDraft(current, 30))}>Later</button></div></header>
      <div className="mini-hours">{slots.map((hour) => <button type="button" key={hour} onClick={() => setState((current) => placeEventDraft(current, hour * 60))}><span>{formatTime(`${String(hour).padStart(2, "0")}:00`)}</span></button>)}{dateEvents.map((event) => { const calendar = calendarById(state, event.calendarId); return <span className="mini-existing" key={event.id} style={{ left: `${((minutesFromTime(event.start) - 8 * 60) / (12 * 60)) * 100}%`, width: `${Math.max(5, ((minutesFromTime(event.end) - minutesFromTime(event.start)) / (12 * 60)) * 100)}%`, "--event-color": calendar.color }}>{event.title}</span>; })}<span className="mini-candidate" style={{ left: `${((minutesFromTime(draft.start) - 8 * 60) / (12 * 60)) * 100}%`, width: `${Math.max(6, ((minutesFromTime(draft.end) - minutesFromTime(draft.start)) / (12 * 60)) * 100)}%` }}>{draft.title || "New event"}</span></div>
      {conflicts.length > 0 ? <p className="conflict-note"><WarningCircle size={16} weight="fill" /><span><strong>{conflicts.length} overlap{conflicts.length > 1 ? "s" : ""}</strong>{conflicts.map((event) => event.title).join(" · ")}</span></p> : <p className="free-note"><CheckCircle size={16} weight="fill" />No overlap at this time.</p>}
    </section>
  );
}

function EventComposer({ state, setState, onClose, announce }) {
  const draft = state.draftEvent;
  const [details, setDetails] = useState(Boolean(draft.notes || draft.attendees.length || draft.repeat !== "Never"));
  if (!draft) return null;
  const canSave = canSaveDraft(state);
  const save = () => {
    if (!canSave) return;
    const editing = Boolean(draft.id);
    setState((current) => saveEventDraft(current));
    announce(editing ? "Event updated in Day, Week, and Search" : "Event added to Day, Week, and Search");
    onClose();
  };
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="event-composer" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit event" : "New event"}>
        <header><label>Calendar<select aria-label="Event calendar" value={draft.calendarId} onChange={(event) => setState((current) => editEventDraft(current, { calendarId: event.target.value }))}>{state.calendars.map((calendar) => <option value={calendar.id} key={calendar.id}>{calendar.name}</option>)}</select></label><button type="button" aria-label="Close event composer" onClick={onClose}><X size={20} weight="bold" /></button></header>
        <div className="composer-scroll">
          <input id="event-composer-title" className="event-title-input" autoFocus aria-label="Event title" value={draft.title} placeholder="Event title" onChange={(event) => setState((current) => editEventDraft(current, { title: event.target.value }))} />
          <div className="date-time-panel">
            <div><label>Starts<input type="date" value={draft.date} onChange={(event) => setState((current) => editEventDraft(current, { date: event.target.value }))} /></label>{!draft.allDay && <input aria-label="Start time" type="time" value={draft.start} onChange={(event) => setState((current) => editEventDraft(current, { start: event.target.value }))} />}</div>
            <ArrowsLeftRight size={24} />
            <div><label>Ends<input type="date" value={draft.endDate} onChange={(event) => setState((current) => editEventDraft(current, { endDate: event.target.value }))} /></label>{!draft.allDay && <input aria-label="End time" type="time" value={draft.end} onChange={(event) => setState((current) => editEventDraft(current, { end: event.target.value }))} />}</div>
          </div>
          <label className="toggle-row"><input type="checkbox" checked={draft.allDay} onChange={(event) => setState((current) => editEventDraft(current, { allDay: event.target.checked, start: event.target.checked ? "00:00" : "11:00", end: event.target.checked ? "23:59" : "12:00" }))} /><span>All day</span></label>
          <label className="field-row"><MapPin size={19} weight="fill" /><input aria-label="Event location" value={draft.location} placeholder="Add location" onChange={(event) => setState((current) => editEventDraft(current, { location: event.target.value }))} /></label>
          <label className="field-row"><Bell size={19} weight="fill" /><select aria-label="Event notification" value={draft.notification} onChange={(event) => setState((current) => editEventDraft(current, { notification: event.target.value }))}><option>None</option><option>10 minutes before</option><option>15 minutes before</option><option>30 minutes before</option><option>1 hour before</option><option>1 day before</option></select></label>
          {draft.source && <button type="button" className="source-link" onClick={() => announce(`Source message: ${draft.source.label}`)}><EnvelopeSimple size={17} /><span><strong>Created from message</strong><small>{draft.source.label}</small></span><LinkSimple size={15} /></button>}
          <button type="button" className="details-toggle" aria-expanded={details} onClick={() => setDetails((current) => !current)}>{details ? "Hide details" : "Notes, invites, repeat, and more"}<CaretDown size={16} /></button>
          {details && <section className="event-details"><label><Notebook size={18} />Notes<textarea value={draft.notes} onChange={(event) => setState((current) => editEventDraft(current, { notes: event.target.value }))} placeholder="Add context…" /></label><label><UserPlus size={18} />Invite<input value={draft.attendees.join(", ")} onChange={(event) => setState((current) => editEventDraft(current, { attendees: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) }))} placeholder="name@example.com" /></label><label><Repeat size={18} />Repeat<select value={draft.repeat} onChange={(event) => setState((current) => editEventDraft(current, { repeat: event.target.value }))}><option>Never</option><option>Every week</option><option>Every 2 weeks</option><option>Every month</option><option>Every year</option></select></label><div className="detail-checks"><label><input type="checkbox" checked={draft.countdown} onChange={(event) => setState((current) => editEventDraft(current, { countdown: event.target.checked }))} />Countdown</label><label><input type="checkbox" checked={draft.circled} onChange={(event) => setState((current) => editEventDraft(current, { circled: event.target.checked }))} />Circle event</label></div></section>}
          {!draft.allDay && <MiniSchedule state={state} setState={setState} />}
        </div>
        <footer><button type="button" className="secondary-action" onClick={onClose}>Cancel</button><button type="button" className="save-event" disabled={!canSave} title={!canSave ? "Add a title and a valid time range" : "Save event"} onClick={save}>{draft.id ? "Update event" : "Add this event"}</button></footer>
      </section>
    </div>
  );
}

function SearchDialog({ state, query, setQuery, onClose, onOpenEvent, onGoDate }) {
  const results = useMemo(() => searchCalendar(state, query), [state, query]);
  return (
    <div className="modal-layer search-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="search-dialog" role="dialog" aria-modal="true" aria-label="Search calendar">
        <header><MagnifyingGlass size={22} /><input autoFocus aria-label="Search events and Journal" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search events and Journal…" /><button type="button" aria-label="Close search" onClick={onClose}><X size={19} /></button></header>
        <div className="search-results">{query && results.length === 0 && <p>No results in visible calendars.</p>}{results.map((result) => <button type="button" key={`${result.type}-${result.id}`} onClick={() => { if (result.type === "Event") onOpenEvent(result.id); else if (result.date) onGoDate(result.date); }}><span>{result.type}</span><strong>{result.title}</strong>{result.date && <small>{formatShortDate(result.date)}</small>}</button>)}</div>
        <footer>Hidden calendars stay out of search results.</footer>
      </section>
    </div>
  );
}

function JournalDialog({ state, setState, date, onClose }) {
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="journal-dialog" role="dialog" aria-modal="true" aria-labelledby="journal-title"><header><div><span>Journal</span><h2 id="journal-title">{formatLongDate(date)}</h2></div><button type="button" aria-label="Close Journal" onClick={onClose}><X size={19} /></button></header><textarea autoFocus aria-label="Journal entry" value={state.journals[date] || ""} onChange={(event) => setState((current) => saveJournal(current, date, event.target.value))} placeholder="Add notes, context, or a memory from this day…" /><footer><span>Autosaved in this prototype</span><button type="button" onClick={onClose}>Done</button></footer></section>
    </div>
  );
}

function HabitsDialog({ state, setState, date, onClose }) {
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="habits-dialog" role="dialog" aria-modal="true" aria-labelledby="habits-title"><header><div><span>Habits</span><h2 id="habits-title">Practice for {formatShortDate(date)}</h2></div><button type="button" aria-label="Close Habits" onClick={onClose}><X size={19} /></button></header><div>{state.habits.map((habit) => { const complete = habit.completedDates.includes(date); return <button type="button" key={habit.id} aria-pressed={complete} onClick={() => setState((current) => toggleHabit(current, habit.id, date))} style={{ "--habit-color": habit.color }}><span>{complete ? <Check size={18} weight="bold" /> : <Footprints size={18} />}</span><strong>{habit.name}</strong><small>{complete ? "Completed for this date" : "Not completed"}</small></button>; })}</div><footer>Habit completion is personal practice, not project progress.</footer></section>
    </div>
  );
}

export function App() {
  const [state, setState] = useState(createInitialState);
  const [route, setRoute] = useState(readRoute);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [journalOpen, setJournalOpen] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef(null);

  const announce = (message) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 2600);
  };

  const navigate = (next, mode = "push") => {
    const complete = { view: "day", date: todayIso, ...next };
    const url = routeUrl(complete);
    if (mode === "replace") window.history.replaceState({ hey: true, route: complete }, "", url);
    else window.history.pushState({ hey: true, route: complete }, "", url);
    setRoute(complete);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const closeDraft = () => setState(discardEventDraft);
  const openEvent = (eventId) => setState((current) => beginEventDraft(current, route.date, eventId));
  const openNewAt = (minutes) => setState((current) => placeEventDraft(beginEventDraft(current, route.date), minutes));

  useEffect(() => {
    if (!window.history.state?.hey) window.history.replaceState({ hey: true, route }, "", window.location.href);
    const pop = () => setRoute(readRoute());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  useEffect(() => {
    const key = (event) => {
      const normalized = event.key.toLowerCase();
      if (normalized === "escape") {
        event.preventDefault();
        if (state.draftEvent) closeDraft();
        else if (searchOpen) { setSearchOpen(false); setSearchQuery(""); }
        else if (journalOpen) setJournalOpen(false);
        else if (habitsOpen) setHabitsOpen(false);
        else if (menuOpen) setMenuOpen(false);
        return;
      }
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (normalized === "d") navigate({ view: "day", date: route.date });
      if (normalized === "u") navigate({ view: "week", date: route.date });
      if (normalized === "y") navigate({ view: "year", date: route.date });
      if (normalized === "t") navigate({ view: "day", date: todayIso });
      if (normalized === "n") setState((current) => beginEventDraft(current, route.date));
      if (normalized === "s" || normalized === "/") setSearchOpen(true);
      if (normalized === "j") setJournalOpen(true);
      if (normalized === "b") setHabitsOpen(true);
      if (event.key === "ArrowLeft") navigate({ ...route, date: addDays(route.date, route.view === "week" ? -7 : route.view === "year" ? -365 : -1) });
      if (event.key === "ArrowRight") navigate({ ...route, date: addDays(route.date, route.view === "week" ? 7 : route.view === "year" ? 365 : 1) });
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [route, state.draftEvent, searchOpen, journalOpen, habitsOpen, menuOpen]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  return (
    <div className="hey-app">
      <AppHeader route={route} navigate={navigate} onMenu={() => setMenuOpen(true)} onNew={() => setState((current) => beginEventDraft(current, route.date))} onSearch={() => setSearchOpen(true)} />
      <DateNavigation route={route} navigate={navigate} />
      {route.view === "day" && <DayView state={state} setState={setState} route={route} navigate={navigate} onOpenEvent={openEvent} onNewAt={openNewAt} onEmail={() => setState((current) => beginEmailEventDraft(current, route.date))} onJournal={() => setJournalOpen(true)} onHabits={() => setHabitsOpen(true)} onDecorate={() => setMenuOpen(true)} />}
      {route.view === "week" && <WeekView state={state} route={route} navigate={navigate} onOpenEvent={openEvent} />}
      {route.view === "year" && <YearView state={state} route={route} navigate={navigate} onOpenEvent={openEvent} />}
      <nav className="mobile-nav" aria-label="Mobile calendar navigation">{["day", "week", "year"].map((view) => <button type="button" key={view} className={route.view === view ? "is-active" : ""} onClick={() => navigate({ view, date: route.date })}>{view[0].toUpperCase() + view.slice(1)}</button>)}<button type="button" className="mobile-new" aria-label="New event" onClick={() => setState((current) => beginEventDraft(current, route.date))}><Plus size={22} weight="bold" /></button></nav>
      {menuOpen && <CalendarMenu state={state} setState={setState} date={route.date} onClose={() => setMenuOpen(false)} onJournal={() => { setMenuOpen(false); setJournalOpen(true); }} onHabits={() => { setMenuOpen(false); setHabitsOpen(true); }} />}
      {state.draftEvent && <EventComposer state={state} setState={setState} onClose={closeDraft} announce={announce} />}
      {searchOpen && <SearchDialog state={state} query={searchQuery} setQuery={setSearchQuery} onClose={() => { setSearchOpen(false); setSearchQuery(""); }} onOpenEvent={(eventId) => { setSearchOpen(false); setSearchQuery(""); openEvent(eventId); }} onGoDate={(date) => { setSearchOpen(false); setSearchQuery(""); navigate({ view: "day", date }); }} />}
      {journalOpen && <JournalDialog state={state} setState={setState} date={route.date} onClose={() => setJournalOpen(false)} />}
      {habitsOpen && <HabitsDialog state={state} setState={setState} date={route.date} onClose={() => setHabitsOpen(false)} />}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}

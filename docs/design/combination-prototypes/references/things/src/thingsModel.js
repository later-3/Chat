export const TODAY_DATE = "2026-08-09";
export const TOMORROW_DATE = "2026-08-10";

export const builtInLists = [
  { id: "inbox", label: "Inbox", icon: "fa-solid fa-inbox", tone: "blue" },
  { id: "today", label: "Today", icon: "fa-solid fa-star", tone: "yellow" },
  { id: "upcoming", label: "Upcoming", icon: "fa-solid fa-calendar-days", tone: "pink" },
  { id: "anytime", label: "Anytime", icon: "fa-solid fa-layer-group", tone: "teal" },
  { id: "someday", label: "Someday", icon: "fa-solid fa-box-archive", tone: "olive" },
  {
    id: "logbook",
    label: "Logbook",
    icon: "fa-solid fa-square-check",
    tone: "green",
    separated: true,
  },
];

export const specialLists = [
  { id: "tomorrow", label: "Tomorrow", icon: "fa-solid fa-calendar-day", tone: "pink" },
  { id: "deadlines", label: "Deadlines", icon: "fa-solid fa-flag", tone: "pink" },
  { id: "repeating", label: "Repeating", icon: "fa-solid fa-rotate", tone: "gray" },
  { id: "all-projects", label: "All Projects", icon: "fa-solid fa-list", tone: "gray" },
  {
    id: "logged-projects",
    label: "Logged Projects",
    icon: "fa-solid fa-square-check",
    tone: "green",
  },
];

const areaFixtures = [
  { id: "family", name: "Family", tags: ["Home"] },
  { id: "work", name: "Work", tags: ["Office"] },
  { id: "hobbies", name: "Hobbies", tags: [] },
];

const projectFixtures = [
  {
    id: "vacation-in-rome",
    name: "Vacation in Rome",
    areaId: "family",
    note: "We’ll go from June 14–22 and visit Jane and Paolo. Maybe do a night out in Trastevere.",
    tags: ["Errand", "Important"],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [
      { id: "planning", title: "Planning", archived: false },
      { id: "things-to-buy", title: "Things to buy", archived: false },
      { id: "things-to-do", title: "Things to do", archived: false },
    ],
  },
  {
    id: "throw-party-for-eve",
    name: "Throw Party for Eve",
    areaId: "family",
    note: "A relaxed birthday dinner with a few close friends.",
    tags: ["Phone"],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "buy-a-new-bike",
    name: "Buy a New Bike",
    areaId: "family",
    note: "Compare commuter bikes and book a test ride.",
    tags: [],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "prepare-presentation",
    name: "Prepare Presentation",
    areaId: "work",
    note: "Keep the talk and slides simple: what are the three things about this that everyone should remember?",
    tags: ["Important", "Diane"],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [
      { id: "slides-and-notes", title: "Slides and notes", archived: false },
      { id: "preparation", title: "Preparation", archived: false },
      { id: "facilities", title: "Facilities", archived: false },
    ],
  },
  {
    id: "onboard-julia",
    name: "Onboard Julia",
    areaId: "work",
    note: "Help Julia meet the team and get productive in her first week.",
    tags: ["Diane"],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "write-user-guide",
    name: "Write User Guide",
    areaId: "work",
    note: "Turn the support outline into a short, useful guide.",
    tags: [],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "order-team-shirts",
    name: "Order Team T-Shirts",
    areaId: "work",
    note: "Collect sizes and confirm the print proof.",
    tags: [],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "learn-basic-italian",
    name: "Learn Basic Italian",
    areaId: "hobbies",
    note: "Practice a little every day before the trip.",
    tags: [],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "run-a-marathon",
    name: "Run a Marathon",
    areaId: "hobbies",
    note: "Build a sustainable training and nutrition plan.",
    tags: [],
    start: "anytime",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "plan-a-garden",
    name: "Plan a Garden",
    areaId: "family",
    note: "A Someday project for exploring a small balcony garden.",
    tags: ["Home"],
    start: "someday",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "company-offsite",
    name: "Company Offsite",
    areaId: "work",
    note: "A future project that becomes active next week.",
    tags: ["Office"],
    start: "on-date",
    startDate: "2026-08-13",
    evening: false,
    status: "open",
    headings: [],
  },
  {
    id: "road-trip-2025",
    name: "Road Trip 2025",
    areaId: "family",
    note: "A completed summer trip.",
    tags: [],
    start: "anytime",
    evening: false,
    status: "completed",
    isLogged: true,
    completedAt: "2026-08-07",
    headings: [],
  },
];

const checklist = (...titles) =>
  titles.map((title, index) => ({ id: `check-${index + 1}`, title, completed: false }));

const taskFixtures = [
  {
    id: "travel-guide",
    title: "Borrow Emma’s travel guide",
    parent: { type: "project", id: "vacation-in-rome" },
    headingId: "planning",
    start: "on-date",
    startDate: TODAY_DATE,
    evening: false,
    note: "Emma said the new edition has the best neighborhood walks.",
    checklist: checklist("Ask Emma when she is home", "Pick it up after work"),
    tags: ["Errand"],
    status: "open",
  },
  {
    id: "expense",
    title: "Finish expense report",
    parent: { type: "area", id: "work" },
    start: "anytime",
    evening: false,
    note: "Add the train receipt and send the report to Finance.",
    checklist: checklist("Add missing receipt", "Review totals", "Submit to Finance"),
    tags: ["Important"],
    deadline: TODAY_DATE,
    status: "open",
  },
  {
    id: "conference",
    title: "Confirm conference call for Friday",
    parent: { type: "area", id: "work" },
    start: "on-date",
    startDate: TODAY_DATE,
    evening: false,
    note: "Confirm the time with the London team.",
    checklist: checklist("Check time zones", "Send final invite"),
    tags: ["Phone"],
    status: "open",
  },
  {
    id: "lunch",
    title: "Organize team lunch",
    parent: { type: "project", id: "onboard-julia" },
    start: "on-date",
    startDate: TODAY_DATE,
    evening: false,
    note: "Find somewhere close to the office with outdoor tables.",
    checklist: checklist("Choose a place", "Book for six people"),
    tags: ["Diane"],
    status: "open",
  },
  {
    id: "milestones",
    title: "Review milestones from last quarter",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "slides-and-notes",
    start: "on-date",
    startDate: TODAY_DATE,
    evening: false,
    note: "Pull out the three lessons that matter for the new plan.",
    checklist: checklist("Read the notes", "Mark key decisions", "Share the summary"),
    tags: ["Important"],
    status: "open",
  },
  {
    id: "dinner",
    title: "Make dinner reservation",
    parent: { type: "project", id: "throw-party-for-eve" },
    start: "on-date",
    startDate: TODAY_DATE,
    evening: true,
    note: "A quiet table for four, around 7:30.",
    checklist: checklist("Check two restaurants", "Confirm with Eve"),
    tags: ["Phone"],
    status: "open",
  },
  {
    id: "field-trip",
    title: "Pack bag for Olivia’s field trip",
    parent: { type: "area", id: "family" },
    start: "on-date",
    startDate: TODAY_DATE,
    evening: true,
    note: "The bus leaves at 08:15 tomorrow.",
    checklist: checklist("Water bottle", "Rain jacket", "Lunch box"),
    tags: [],
    status: "open",
    checklistMark: true,
  },
  {
    id: "nutrition",
    title: "Read article about nutrition",
    parent: { type: "project", id: "run-a-marathon" },
    start: "on-date",
    startDate: TODAY_DATE,
    evening: true,
    note: "Save any useful notes for next week’s meal plan.",
    checklist: checklist("Read the article", "Capture three notes"),
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "kindergarten",
    title: "Notify Kindergarten about vacay dates",
    parent: { type: "none" },
    isInbox: true,
    start: "anytime",
    evening: false,
    note: "info@kindergarten.com",
    checklist: [],
    tags: ["Phone"],
    deadline: "2026-08-14",
    status: "open",
  },
  {
    id: "check-it",
    title: "Check with IT",
    parent: { type: "none" },
    isInbox: true,
    start: "anytime",
    evening: false,
    note: "Ask whether the new laptop image is ready.",
    checklist: [],
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "groceries",
    title: "Buy groceries for dinner",
    parent: { type: "none" },
    isInbox: true,
    start: "anytime",
    evening: false,
    note: "Tomatoes, basil, pasta, parmesan.",
    checklist: checklist("Tomatoes", "Basil", "Pasta", "Parmesan"),
    tags: [],
    status: "open",
  },
  {
    id: "restaurants",
    title: "Check out restaurants",
    parent: { type: "project", id: "throw-party-for-eve" },
    start: "on-date",
    evening: false,
    startDate: TOMORROW_DATE,
    note: "Shortlist three places close to Eve.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "proposal",
    title: "Resubmit design proposal",
    parent: { type: "area", id: "work" },
    start: "on-date",
    evening: false,
    startDate: TOMORROW_DATE,
    note: "Incorporate the final review comments.",
    checklist: [],
    tags: ["Important"],
    status: "open",
  },
  {
    id: "office-supplies",
    title: "Order office supplies",
    parent: { type: "area", id: "work" },
    start: "on-date",
    evening: false,
    startDate: "2026-08-11",
    note: "Printer paper, markers, and tape.",
    checklist: [],
    tags: ["Office"],
    status: "open",
  },
  {
    id: "eve-gift",
    title: "Buy a gift for Eve",
    parent: { type: "project", id: "throw-party-for-eve" },
    start: "on-date",
    evening: false,
    startDate: "2026-08-11",
    note: "Look for the ceramics set she mentioned.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "hiking-trip",
    title: "Plan weekend hiking trip",
    parent: { type: "area", id: "family" },
    start: "on-date",
    evening: false,
    startDate: "2026-08-11",
    note: "Choose a route with an easy return train.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "italian-practice",
    title: "Practice Italian for 10 minutes",
    parent: { type: "project", id: "learn-basic-italian" },
    start: "on-date",
    evening: false,
    startDate: "2026-08-11",
    note: "Review greetings and restaurant phrases.",
    checklist: [],
    tags: [],
    repeat: true,
    status: "open",
  },
  {
    id: "handouts",
    title: "Print handouts for attendees",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "slides-and-notes",
    start: "on-date",
    evening: false,
    startDate: "2026-08-12",
    note: "Print twenty copies after the final proof.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "haircut",
    title: "Get a haircut",
    parent: { type: "none" },
    start: "anytime",
    evening: false,
    note: "Book the place near the station.",
    checklist: [],
    tags: ["Errand"],
    status: "open",
  },
  {
    id: "plumber",
    title: "Call the plumber",
    parent: { type: "area", id: "family" },
    start: "anytime",
    evening: false,
    note: "The kitchen tap is leaking again.",
    checklist: [],
    tags: ["Phone"],
    status: "open",
    attachment: true,
  },
  {
    id: "colosseum",
    title: "Visit the Colosseum",
    parent: { type: "project", id: "vacation-in-rome" },
    headingId: "things-to-do",
    start: "anytime",
    evening: false,
    note: "Book the early entry slot.",
    checklist: [],
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "book-flights",
    title: "Book flights",
    parent: { type: "project", id: "vacation-in-rome" },
    headingId: "planning",
    start: "anytime",
    evening: false,
    note: "Compare the direct morning flights.",
    checklist: [],
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "karaoke",
    title: "Ask Greg about karaoke places",
    parent: { type: "project", id: "throw-party-for-eve" },
    start: "anytime",
    evening: false,
    note: "Greg mentioned a place with private rooms.",
    checklist: [],
    tags: ["Phone"],
    status: "open",
  },
  {
    id: "story-opening",
    title: "Review the story and simplify the opening",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "slides-and-notes",
    start: "anytime",
    evening: false,
    note: "Open with the customer problem, not the timeline.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "slide-layouts",
    title: "Update slide layouts",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "slides-and-notes",
    start: "anytime",
    evening: false,
    note: "Use the simpler title and evidence layouts.",
    checklist: checklist("Title slide", "Evidence slide"),
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "olivia-data",
    title: "Review quarterly data with Olivia",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "slides-and-notes",
    start: "anytime",
    evening: false,
    note: "Verify the retention chart before sharing it.",
    checklist: [],
    tags: ["Important"],
    status: "open",
  },
  {
    id: "email-john",
    title: "Email John for presentation tips",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "preparation",
    start: "anytime",
    evening: false,
    note: "Ask how he keeps the final section concise.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "book-recommendations",
    title: "Check out book recommendations",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "preparation",
    start: "anytime",
    evening: false,
    note: "Look up the three storytelling books from John.",
    checklist: [],
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "full-rehearsal",
    title: "Time a full rehearsal",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "preparation",
    start: "anytime",
    evening: false,
    note: "Keep the complete run under twenty minutes.",
    checklist: [],
    tags: ["Important"],
    status: "open",
  },
  {
    id: "practice-eric",
    title: "Do a practice run with Eric",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "preparation",
    start: "anytime",
    evening: false,
    note: "Ask Eric to flag unclear transitions.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "confirm-time",
    title: "Confirm presentation time",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "preparation",
    start: "anytime",
    evening: false,
    note: "Confirm the room opens thirty minutes early.",
    checklist: [],
    tags: ["Important"],
    deadline: "2026-08-13",
    status: "open",
  },
  {
    id: "conference-room",
    title: "Book the conference room",
    parent: { type: "project", id: "prepare-presentation" },
    headingId: "facilities",
    start: "anytime",
    evening: false,
    note: "Reserve the large room with the new projector.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "photo-book",
    title: "Create Photo Book",
    parent: { type: "area", id: "family" },
    start: "someday",
    evening: false,
    note: "Choose the best photos from this year.",
    checklist: checklist("Pick a service", "Choose photos", "Write captions"),
    tags: [],
    status: "open",
  },
  {
    id: "rollercoasters",
    title: "Ride World’s Biggest Rollercoasters",
    parent: { type: "area", id: "family" },
    start: "someday",
    evening: false,
    note: "Keep a list of parks worth visiting.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "treehouse",
    title: "Build a Treehouse",
    parent: { type: "area", id: "family" },
    start: "someday",
    evening: false,
    note: "Sketch ideas before deciding whether to do it.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "new-laptop",
    title: "Set Up a New Laptop",
    parent: { type: "area", id: "work" },
    start: "someday",
    evening: false,
    note: "Turn the setup into a repeatable checklist.",
    checklist: checklist("Install tools", "Restore settings"),
    tags: [],
    status: "open",
  },
  {
    id: "business-trip",
    title: "Business trip checklist",
    parent: { type: "area", id: "work" },
    start: "someday",
    evening: false,
    note: "Reuse this before the next conference.",
    checklist: checklist("Tickets", "Hotel", "Presentation adapter"),
    tags: [],
    status: "open",
  },
  {
    id: "reading-list",
    title: "Reading List",
    parent: { type: "area", id: "hobbies" },
    start: "someday",
    evening: false,
    note: "Books to revisit when there is more time.",
    checklist: checklist("Designing for People", "The Creative Act"),
    tags: [],
    status: "open",
    attachment: true,
  },
  {
    id: "write-novel",
    title: "Write a Novel in 30 Days",
    parent: { type: "area", id: "hobbies" },
    start: "someday",
    evening: false,
    note: "A possible November experiment.",
    checklist: [],
    tags: [],
    status: "open",
  },
  {
    id: "tax-return",
    title: "Submit tax return",
    parent: { type: "area", id: "family" },
    start: "anytime",
    evening: false,
    note: "Filed successfully.",
    checklist: [],
    tags: ["Important"],
    status: "completed",
    isLogged: true,
    completedAt: TODAY_DATE,
  },
  {
    id: "library-card",
    title: "Renew library card",
    parent: { type: "area", id: "hobbies" },
    start: "anytime",
    evening: false,
    note: "Canceled after switching libraries.",
    checklist: [],
    tags: ["Errand"],
    status: "canceled",
    isLogged: true,
    completedAt: "2026-08-08",
  },
];

export const initialThingsState = {
  areas: areaFixtures,
  projects: projectFixtures,
  tasks: taskFixtures,
  tags: ["Important", "Diane", "Office", "Errand", "Phone", "Home", "Pending"],
};

export function cloneInitialThingsState() {
  return structuredClone(initialThingsState);
}

export function getArea(state, id) {
  return state.areas.find((area) => area.id === id) ?? null;
}

export function getProject(state, id) {
  return state.projects.find((project) => project.id === id) ?? null;
}

export function getParentLabel(state, task) {
  if (task.parent.type === "project") return getProject(state, task.parent.id)?.name ?? "No Project";
  if (task.parent.type === "area") return getArea(state, task.parent.id)?.name ?? "No Area";
  return task.isInbox ? "Inbox" : "";
}

export function getTasksForView(state, viewId) {
  const open = state.tasks.filter((task) => task.status === "open");
  if (viewId === "inbox") return open.filter((task) => task.isInbox);
  if (viewId === "today") {
    return open.filter(
      (task) =>
        (!task.isInbox && task.start === "on-date" && task.startDate === TODAY_DATE) ||
        task.deadline === TODAY_DATE,
    );
  }
  if (viewId === "upcoming") {
    return open.filter(
      (task) =>
        !task.isInbox &&
        ((task.start === "on-date" && task.startDate > TODAY_DATE) ||
          (task.deadline && task.deadline > TODAY_DATE)),
    );
  }
  if (viewId === "anytime") {
    return open.filter(
      (task) =>
        !task.isInbox &&
        (task.start === "anytime" ||
          (task.start === "on-date" && task.startDate <= TODAY_DATE)),
    );
  }
  if (viewId === "someday") return open.filter((task) => !task.isInbox && task.start === "someday");
  if (viewId === "logbook") return state.tasks.filter((task) => task.isLogged);
  if (viewId === "tomorrow") {
    return open.filter(
      (task) => !task.isInbox && task.start === "on-date" && task.startDate === TOMORROW_DATE,
    );
  }
  if (viewId === "deadlines") return open.filter((task) => Boolean(task.deadline));
  if (viewId === "repeating") return open.filter((task) => task.repeat);
  if (viewId.startsWith("area:")) {
    const areaId = viewId.slice(5);
    const projectIds = new Set(
      state.projects.filter((project) => project.areaId === areaId).map((project) => project.id),
    );
    return open.filter(
      (task) =>
        (task.parent.type === "area" && task.parent.id === areaId) ||
        (task.parent.type === "project" && projectIds.has(task.parent.id)),
    );
  }
  if (viewId.startsWith("project:")) {
    const projectId = viewId.slice(8);
    return open.filter((task) => task.parent.type === "project" && task.parent.id === projectId);
  }
  if (viewId.startsWith("tag:")) {
    const tag = viewId.slice(4);
    return open.filter((task) => task.tags.includes(tag));
  }
  return [];
}

export function scheduleTask(tasks, id, value) {
  return tasks.map((task) => {
    if (task.id !== id) return task;
    if (value === "today") {
      return {
        ...task,
        isInbox: false,
        start: "on-date",
        startDate: TODAY_DATE,
        evening: false,
      };
    }
    if (value === "evening") {
      return {
        ...task,
        isInbox: false,
        start: "on-date",
        startDate: TODAY_DATE,
        evening: true,
      };
    }
    if (value === "tomorrow") {
      return {
        ...task,
        isInbox: false,
        start: "on-date",
        startDate: TOMORROW_DATE,
        evening: false,
      };
    }
    if (value === "someday") {
      return { ...task, isInbox: false, start: "someday", startDate: undefined, evening: false };
    }
    if (value === "clear") {
      return { ...task, isInbox: false, start: "anytime", startDate: undefined, evening: false };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return {
        ...task,
        isInbox: false,
        start: "on-date",
        startDate: value,
        evening: false,
      };
    }
    return task;
  });
}

export function moveTask(tasks, id, destination) {
  return tasks.map((task) => {
    if (task.id !== id) return task;
    const parent =
      destination.type === "heading"
        ? { type: "project", id: destination.projectId }
        : destination.type === "project" || destination.type === "area"
          ? { type: destination.type, id: destination.id }
          : { type: "none" };
    return {
      ...task,
      parent,
      headingId: destination.type === "heading" ? destination.id : undefined,
      isInbox: destination.type === "inbox",
    };
  });
}

export function completeTask(tasks, id, completedAt = TODAY_DATE, status = "completed") {
  const snapshot = tasks.find((task) => task.id === id) ?? null;
  return {
    tasks: tasks.map((task) =>
      task.id === id ? { ...task, status, isLogged: true, completedAt } : task,
    ),
    snapshot,
  };
}

export function restoreTask(tasks, snapshot) {
  if (!snapshot) return tasks;
  return tasks.map((task) => (task.id === snapshot.id ? snapshot : task));
}

export function getNewTaskDefaults(viewId, state) {
  if (viewId === "inbox") {
    return {
      parent: { type: "none" },
      isInbox: true,
      start: "anytime",
      evening: false,
      tags: [],
    };
  }
  if (viewId === "today") {
    return {
      parent: { type: "none" },
      isInbox: false,
      start: "on-date",
      startDate: TODAY_DATE,
      evening: false,
      tags: [],
    };
  }
  if (viewId === "upcoming" || viewId === "tomorrow") {
    return {
      parent: { type: "none" },
      isInbox: false,
      start: "on-date",
      startDate: TOMORROW_DATE,
      evening: false,
      tags: [],
    };
  }
  if (viewId === "anytime") {
    return {
      parent: { type: "none" },
      isInbox: false,
      start: "anytime",
      evening: false,
      tags: [],
    };
  }
  if (viewId === "someday") {
    return {
      parent: { type: "none" },
      isInbox: false,
      start: "someday",
      evening: false,
      tags: [],
    };
  }
  if (viewId.startsWith("area:")) {
    return {
      parent: { type: "area", id: viewId.slice(5) },
      isInbox: false,
      start: "anytime",
      evening: false,
      tags: [],
    };
  }
  if (viewId.startsWith("project:")) {
    return {
      parent: { type: "project", id: viewId.slice(8) },
      isInbox: false,
      start: "anytime",
      evening: false,
      tags: [],
    };
  }
  if (viewId.startsWith("tag:")) {
    return {
      parent: { type: "none" },
      isInbox: false,
      start: "anytime",
      evening: false,
      tags: [viewId.slice(4)],
    };
  }
  return {
    parent: { type: "none" },
    isInbox: true,
    start: "anytime",
    evening: false,
    tags: [],
  };
}

export function buildQuickFindResults(state, query, { extended = false } = {}) {
  const normalized = query.trim().toLowerCase();
  const isSubsequence = (needle, haystack) => {
    let cursor = 0;
    for (const character of haystack) {
      if (character === needle[cursor]) cursor += 1;
      if (cursor === needle.length) return true;
    }
    return needle.length === 0;
  };
  const matches = (value) => {
    const haystack = value.toLowerCase();
    return !normalized || haystack.includes(normalized) || isSubsequence(normalized, haystack);
  };

  const rows = [
    ...builtInLists.map((list) => ({
      ...list,
      type: "list",
      title: list.label,
      viewId: list.id,
    })),
    ...specialLists.map((list) => ({
      ...list,
      type: "special",
      title: list.label,
      viewId: list.id,
    })),
    {
      type: "settings",
      id: "settings",
      viewId: "settings",
      title: "Settings",
      icon: "fa-solid fa-sliders",
      tone: "gray",
    },
    ...state.areas.map((area) => ({
      type: "area",
      id: area.id,
      viewId: `area:${area.id}`,
      title: area.name,
      icon: "fa-solid fa-cube",
      tone: "gray",
    })),
    ...state.projects.map((project) => ({
      type: "project",
      id: project.id,
      viewId: `project:${project.id}`,
      title: project.name,
      icon: "fa-solid fa-circle-half-stroke",
      tone: project.status === "open" ? "gray" : "green",
      meta: getArea(state, project.areaId)?.name,
      searchable: `${project.name} ${project.note}`,
    })),
    ...state.projects.flatMap((project) =>
      project.headings.map((heading) => ({
        type: "heading",
        id: heading.id,
        viewId: `project:${project.id}`,
        title: heading.title,
        icon: "fa-solid fa-heading",
        tone: "gray",
        meta: project.name,
      })),
    ),
    ...state.tags.map((tag) => ({
      type: "tag",
      id: tag,
      viewId: `tag:${tag}`,
      title: tag,
      icon: "fa-solid fa-tag",
      tone: "gray",
      meta: "Tag",
    })),
    ...state.tasks.map((task) => ({
      type: "task",
      id: task.id,
      viewId: task.status === "open" ? null : "logbook",
      title: task.title,
      icon: task.status === "open" ? "fa-regular fa-square" : "fa-solid fa-square-check",
      tone: task.status === "open" ? "gray" : "green",
      meta: getParentLabel(state, task),
      status: task.status,
      isLogged: task.isLogged,
      searchable: extended
        ? `${task.title} ${task.note} ${task.checklist.map((item) => item.title).join(" ")}`
        : task.title,
    })),
  ];

  const filtered = rows.filter((row) => {
    if (!extended && row.type === "task" && row.isLogged) return false;
    return matches(row.searchable ?? `${row.title} ${row.meta ?? ""}`);
  });

  if (!normalized) {
    const defaults = ["today", "inbox", "upcoming", "anytime"];
    return [
      ...filtered.filter((row) => defaults.includes(row.id)),
      ...filtered.filter((row) => row.type === "project" && row.status !== "completed").slice(0, 4),
    ];
  }
  return filtered.slice(0, extended ? 16 : 10);
}

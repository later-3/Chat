export const avatars = {
  geoff: "/reference-assets/basecamp/avatars/geoff.jpg",
  kimberly: "/reference-assets/basecamp/avatars/kimberly.jpg",
  alex: "/reference-assets/basecamp/avatars/alex.jpg",
  christina: "/reference-assets/basecamp/avatars/christina.jpg",
  marcus: "/reference-assets/basecamp/avatars/marcus.jpg",
  sofia: "/reference-assets/basecamp/avatars/sofia.jpg",
  daniel: "/reference-assets/basecamp/avatars/daniel.jpg",
  maya: "/reference-assets/basecamp/avatars/maya.jpg",
  noah: "/reference-assets/basecamp/avatars/noah.jpg",
  zoe: "/reference-assets/basecamp/avatars/zoe.jpg",
};

export const people = [
  { id: "geoff", name: "Geoff Collier", shortName: "Geoff C.", role: "Head of Design" },
  { id: "kimberly", name: "Leah Bernstein", shortName: "Leah B.", role: "Customer Advocate" },
  { id: "marcus", name: "Kurt Holloway", shortName: "Kurt H.", role: "Customer Advocate" },
  { id: "daniel", name: "Daniel Young", shortName: "Daniel Y.", role: "Developer" },
  { id: "sofia", name: "Sofía Cruz", shortName: "Sofía C.", role: "Designer" },
  { id: "alex", name: "Alex Zhang", shortName: "Alex Z.", role: "Marketing" },
  { id: "christina", name: "Christina Moore", shortName: "Christina M.", role: "Operations" },
  { id: "maya", name: "Maya Patel", shortName: "Maya P.", role: "Producer" },
];

export const toolCatalog = [
  { id: "message", name: "Message Board", singular: "message", image: "/reference-assets/basecamp/basecamp-tools/message-board.webp", icon: "fa-message" },
  { id: "docs", name: "Docs & Files", singular: "document", image: "/reference-assets/basecamp/basecamp-tools/docs-files.webp", icon: "fa-folder-open" },
  { id: "todos", name: "Project Tasks", singular: "to-do", image: "/reference-assets/basecamp/basecamp-tools/to-dos.webp", icon: "fa-square-check" },
  { id: "chat", name: "Chat", singular: "message", image: "/reference-assets/basecamp/basecamp-tools/chat.webp", icon: "fa-comments" },
  { id: "schedule", name: "Schedule", singular: "event", image: "/reference-assets/basecamp/basecamp-tools/schedule.webp", icon: "fa-calendar-day" },
  { id: "cards", name: "Workflow", singular: "card", image: "/reference-assets/basecamp/basecamp-tools/card-table.webp", icon: "fa-table-columns" },
];

const projectFixtures = [
  { id: "enormicom", name: "Enormicom HQ", note: "Where everybody knows your name.", access: "All-access", starred: true, color: "green", people: ["geoff", "kimberly", "alex", "christina", "sofia", "maya"] },
  { id: "website", name: "Website Redesign", note: "Nine to Thrive", starred: true, color: "blue", people: ["geoff", "kimberly", "alex", "christina", "sofia", "maya"] },
  { id: "gh-designs", name: "GH Designs: Logo Redesign", note: "Lead: Sofía · Phase 2", access: "All-access", starred: true, color: "violet", people: ["sofia", "geoff", "daniel"] },
  { id: "demo", name: "A fun demo", note: "A safe place to explore Basecamp", starred: true, color: "cyan", people: ["geoff"] },
  { id: "cycle-2", name: "Cycle 2: Product Updates", note: "Product work in progress", access: "All-access", decorated: true, starred: false, color: "orange", people: ["daniel", "alex"] },
  { id: "accounting", name: "Accounting Team", note: "We know where the money is at!", access: "All-access", starred: false, color: "yellow", people: ["christina", "kimberly"] },
  { id: "meetup", name: "Company Meetup: Austin, TX", note: "May 18th–22nd", footer: "26 people", starred: false, color: "pink", people: ["maya", "geoff", "kimberly", "alex"] },
  { id: "cycle-1", name: "Cycle 1: Marketing", note: "Launch planning and campaign work", access: "All-access", starred: false, color: "red", people: ["alex", "maya"] },
];

const coreTodos = [
  { id: "kickoff", projectId: "enormicom", listId: "discovery", title: "Run project kickoff and define scope", ownerId: "geoff", due: "2026-07-31", dueLabel: "Fri, Jul 31", done: false, createdBy: "geoff", createdLabel: "July 23", notes: "Kickoff agenda, scope, stakeholders, and decisions.", bookmarked: false, subtasks: [
    { id: "kickoff-call", title: "Schedule call with client and stakeholders", ownerId: "geoff", done: true },
    { id: "kickoff-goals", title: "Confirm goals, audience, and success criteria", ownerId: "kimberly", done: false },
    { id: "kickoff-timeline", title: "Agree on timeline, milestones, and sign-off", ownerId: "kimberly", done: false },
  ], comments: [
    { id: "comment-1", authorId: "geoff", time: "Today 10:55am", body: "Kickoff call is booked. I’ve got the client project lead and their ops manager confirmed. I’ll keep chasing their marketing lead." },
    { id: "comment-2", authorId: "kimberly", time: "Today 10:57am", body: "Nice, thanks Geoff. Please keep chasing the marketing lead — last time we found out about their campaign timeline too late." },
    { id: "comment-3", authorId: "marcus", time: "Today 11:01am", body: "There’s a long stretch between kickoff and mockups. Let’s add a check-in so we catch a misread brief earlier." },
  ] },
  { id: "assets", projectId: "enormicom", listId: "discovery", title: "Gather brand assets, photos, and copy from client", ownerId: "daniel", due: "2026-07-31", dueLabel: "Fri, Jul 31", done: false, createdBy: "daniel", createdLabel: "July 24", notes: "Asset checklist and client folder", bookmarked: false, subtasks: [], comments: [] },
  { id: "mockups", projectId: "enormicom", listId: "discovery", title: "Walk client through visual mockups for sign-off", ownerId: "marcus", due: "2026-08-07", dueLabel: "Aug 7", done: false, createdBy: "sofia", createdLabel: "July 24", notes: "Review the desktop and mobile concepts together.", bookmarked: false, subtasks: [], comments: [] },
  { id: "revisions", projectId: "enormicom", listId: "discovery", title: "Revise mockups based on client feedback", ownerId: "daniel", due: "2026-08-14", dueLabel: "Aug 14", done: false, createdBy: "sofia", createdLabel: "July 24", notes: "Capture each decision in the design review thread.", bookmarked: false, subtasks: [], comments: [] },
  { id: "decisions", projectId: "enormicom", listId: "discovery", title: "Document discovery decisions", ownerId: "kimberly", due: "2026-07-25", dueLabel: "Completed", done: true, createdBy: "kimberly", createdLabel: "July 21", notes: "Discovery summary", bookmarked: false, subtasks: [], comments: [] },
  { id: "homepage", projectId: "enormicom", listId: "launch", title: "Build homepage and global navigation", ownerId: "daniel", due: "2026-08-14", dueLabel: "Aug 14", done: false, createdBy: "daniel", createdLabel: "July 27", notes: "Implement the approved responsive shell.", bookmarked: false, subtasks: [], comments: [] },
  { id: "pages", projectId: "enormicom", listId: "launch", title: "Build out key pages", ownerId: "geoff", due: "2026-08-21", dueLabel: "Aug 21", done: false, createdBy: "geoff", createdLabel: "July 27", notes: "Prioritize the core conversion path.", bookmarked: false, subtasks: [], comments: [] },
  { id: "qa", projectId: "enormicom", listId: "launch", title: "QA across browsers and mobile breakpoints", ownerId: "kimberly", due: "2026-08-28", dueLabel: "Aug 28", done: false, createdBy: "kimberly", createdLabel: "July 28", notes: "Desktop, tablet and mobile checks.", bookmarked: false, subtasks: [], comments: [] },
  { id: "deploy", projectId: "enormicom", listId: "launch", title: "Deploy to production and hand off credentials", ownerId: "marcus", due: "2026-09-04", dueLabel: "Sep 4", done: false, createdBy: "marcus", createdLabel: "July 28", notes: "Confirm rollback and ownership.", bookmarked: false, subtasks: [], comments: [] },
];

const secondaryTodos = projectFixtures.slice(1).flatMap((project, index) => [
  { id: `${project.id}-next`, projectId: project.id, listId: "next", title: `Review the next milestone for ${project.name}`, ownerId: project.people[0] || "geoff", due: `2026-08-${String(12 + index).padStart(2, "0")}`, dueLabel: `Aug ${12 + index}`, done: false, createdBy: "geoff", createdLabel: "August 1", notes: `Keep ${project.name} moving with a clear next step.`, bookmarked: false, subtasks: [], comments: [] },
  { id: `${project.id}-recap`, projectId: project.id, listId: "next", title: `Share a weekly recap for ${project.name}`, ownerId: project.people[1] || "kimberly", due: `2026-08-${String(19 + index).padStart(2, "0")}`, dueLabel: `Aug ${19 + index}`, done: index % 3 === 0, createdBy: "kimberly", createdLabel: "August 1", notes: "Summarize decisions, progress, and blockers.", bookmarked: false, subtasks: [], comments: [] },
]);

export const listDefinitions = {
  discovery: { id: "discovery", title: "Discovery & Design", description: "Client kickoff, content gathering, sitemap, and visual design.", tone: "green", hill: 52 },
  launch: { id: "launch", title: "Build & Launch", description: "Front-end build, QA, SEO/analytics setup, and production launch.", tone: "cyan", hill: 72 },
  next: { id: "next", title: "Next up", description: "The current set of project commitments.", tone: "blue", hill: 44 },
};

export const aggregateViews = [
  { id: "activity", title: "Activity", eyebrow: "Across the account", icon: "fa-chart-line", description: "A chronological view of work across every project." },
  { id: "calendar", title: "Calendar", eyebrow: "Across the account", icon: "fa-calendar-day", description: "Dated to-dos and events from every project." },
  { id: "reports", title: "Reports", eyebrow: "Across the account", icon: "fa-chart-pie", description: "Upcoming assignments, overdue work, progress, and people." },
  { id: "everything", title: "Everything", eyebrow: "Across the account", icon: "fa-earth-americas", description: "Browse messages, files, to-dos, events, chats, and cards." },
  { id: "my-tasks", title: "My Tasks", eyebrow: "My work", icon: "fa-list-check", description: "Assignments you’ve pulled into focus." },
  { id: "my-events", title: "My Events", eyebrow: "My work", icon: "fa-calendar", description: "Events and deadlines relevant to you." },
  { id: "do-today", title: "Do Today", eyebrow: "My work", icon: "fa-sun", description: "The work you need to pay attention to today." },
  { id: "bookmarks", title: "My Bookmarks", eyebrow: "My work", icon: "fa-bookmark", description: "Saved tools and to-dos from across projects." },
  { id: "notes", title: "My Notes", eyebrow: "My work", icon: "fa-note-sticky", description: "Private notes only you can see." },
  { id: "notifications", title: "New for you", eyebrow: "Inbox", icon: "fa-bell", description: "Direct notifications and mentions that need your attention." },
];

export const initialActivity = [
  { id: "activity-1", when: "7:00am", icon: "fa-check", tone: "green", people: ["kimberly"], lead: "Kimberly R.", text: "added 3 to-dos to", link: "New to-do list", projectId: "website", target: { view: "tool", projectId: "website", toolId: "todos" } },
  { id: "activity-2", when: "May 25", icon: "fa-list", tone: "green", people: ["geoff"], lead: "Geoff C.", text: "completed 2 subtasks on", link: "Run project kickoff", projectId: "enormicom", target: { view: "todo", projectId: "enormicom", toolId: "todos", todoId: "kickoff" } },
  { id: "activity-3", when: "May 25", icon: "fa-comment", tone: "cyan", people: ["kimberly", "alex", "christina", "marcus"], lead: "Kimberly R., Alex Z., Christina M., and 6 others", text: "were chatting in", link: "Chat", projectId: "demo", target: { view: "tool", projectId: "demo", toolId: "chat" } },
  { id: "activity-4", when: "May 25", icon: "fa-calendar-day", tone: "pink", people: ["geoff"], lead: "Geoff C.", text: "rescheduled 2 events in", link: "Schedule", projectId: "enormicom", target: { view: "tool", projectId: "enormicom", toolId: "schedule" } },
  { id: "activity-5", when: "May 25", icon: "fa-file", tone: "yellow", people: ["kimberly"], lead: "Kimberly R.", text: "posted a document:", link: "Podcast Stats", projectId: "cycle-1", target: { view: "tool", projectId: "cycle-1", toolId: "docs" } },
];

export function createInitialState() {
  return {
    projects: structuredClone(projectFixtures),
    folders: [{ id: "client-work", name: "Client work", projectIds: ["website", "gh-designs"] }],
    todos: structuredClone([...coreTodos, ...secondaryTodos]),
    activity: structuredClone(initialActivity),
    toolItems: {
      message: ["Welcome to Enormicom HQ", "Weekly client update", "Decisions from kickoff"],
      docs: ["Brand guidelines.pdf", "Client feedback.md", "Project brief.docx"],
      chat: ["Morning! The kickoff notes are ready.", "I added the revised timeline.", "Looks good — sharing with the client."],
      schedule: ["Project kickoff · Jul 31", "Design review · Aug 7", "Launch readiness · Aug 28"],
      cards: ["New requests", "Working on", "Client review", "Done"],
    },
    messageThreads: [
      { id: "message-welcome", projectId: "enormicom", title: "Welcome to Enormicom HQ", category: "Announcements", pinned: true, authorId: "kimberly", updated: "Today at 9:10am", body: "Use this space for durable announcements, proposals, and decisions everyone may need later.", replies: [
        { id: "reply-welcome-1", authorId: "geoff", time: "Today at 9:22am", body: "Got it — quick coordination stays in Chat, final decisions stay here." },
      ] },
      { id: "message-update", projectId: "enormicom", title: "Weekly client update", category: "Updates", pinned: false, authorId: "geoff", updated: "Yesterday", body: "The client approved the navigation direction. The next review focuses on responsive layouts.", replies: [
        { id: "reply-update-1", authorId: "sofia", time: "Yesterday at 4:40pm", body: "I’ll attach the revised mobile screens before the review." },
        { id: "reply-update-2", authorId: "daniel", time: "Yesterday at 5:05pm", body: "I’ll confirm the component constraints in the same thread." },
      ] },
      { id: "message-decisions", projectId: "enormicom", title: "Decisions from kickoff", category: "Decisions", pinned: false, authorId: "geoff", updated: "Monday", body: "We agreed to launch the core conversion path first and defer the resource library.", replies: [] },
    ],
    documents: [
      { id: "doc-brand", projectId: "enormicom", title: "Brand guidelines.pdf", type: "PDF", folder: "Brand", updated: "Today", summary: "Logo use, color values, typography, and voice principles." },
      { id: "doc-feedback", projectId: "enormicom", title: "Client feedback.md", type: "Document", folder: "Research", updated: "Yesterday", summary: "Consolidated feedback from the kickoff and first design review." },
      { id: "doc-brief", projectId: "enormicom", title: "Project brief.docx", type: "Document", folder: "Planning", updated: "Monday", summary: "Audience, goals, success criteria, constraints, and launch scope." },
      { id: "doc-prototype", projectId: "enormicom", title: "Interactive prototype", type: "Link", folder: "Design", updated: "Friday", summary: "The current client-facing prototype and review notes." },
    ],
    chatMessages: [
      { id: "chat-1", projectId: "enormicom", authorId: "kimberly", time: "9:14am", body: "Morning! The kickoff notes are ready." },
      { id: "chat-2", projectId: "enormicom", authorId: "daniel", time: "9:21am", body: "I added the revised timeline." },
      { id: "chat-3", projectId: "enormicom", authorId: "geoff", time: "9:28am", body: "Looks good — sharing with the client." },
      { id: "chat-4", projectId: "enormicom", authorId: "sofia", time: "9:36am", body: "I’ll stay here for quick feedback during the review." },
    ],
    scheduleEvents: [
      { id: "event-kickoff", projectId: "enormicom", title: "Project kickoff", date: "2026-07-31", dateLabel: "Fri, Jul 31", time: "10:00am", kind: "Event" },
      { id: "event-review", projectId: "enormicom", title: "Design review", date: "2026-08-07", dateLabel: "Fri, Aug 7", time: "2:00pm", kind: "Milestone" },
      { id: "event-launch", projectId: "enormicom", title: "Launch readiness", date: "2026-08-28", dateLabel: "Fri, Aug 28", time: "11:30am", kind: "Event" },
    ],
    workflowColumns: [
      { id: "new", title: "New requests" },
      { id: "working", title: "Working on" },
      { id: "review", title: "Client review" },
      { id: "done", title: "Done" },
    ],
    workflowCards: [
      { id: "card-copy", projectId: "enormicom", title: "Confirm homepage copy", columnId: "new", ownerId: "alex" },
      { id: "card-nav", projectId: "enormicom", title: "Build responsive navigation", columnId: "working", ownerId: "daniel" },
      { id: "card-mobile", projectId: "enormicom", title: "Review mobile mockups", columnId: "review", ownerId: "sofia" },
      { id: "card-brief", projectId: "enormicom", title: "Approve project brief", columnId: "done", ownerId: "geoff" },
    ],
    foldersOpen: [],
    notes: ["Ask about the marketing campaign timeline.", "Bring revised sitemap to Friday review."],
    notifications: [
      { id: "n1", text: "Leah mentioned you on Run project kickoff", read: false },
      { id: "n2", text: "Daniel assigned you Build out key pages", read: false },
      { id: "n3", text: "Sofía posted a new design review", read: false },
      { id: "n4", text: "Kickoff moved to Friday at 10am", read: false },
      { id: "n5", text: "Kimberly commented in Project Tasks", read: false },
    ],
    invitations: [],
    themeIndex: 0,
    nextId: 100,
    hillUpdates: [{ id: "hill-1", label: "Monday at 1:38pm", summary: "Discovery moved over the hill." }],
  };
}

export function personById(id) {
  return people.find((person) => person.id === id) || people[0];
}

export function projectById(state, id) {
  return state.projects.find((project) => project.id === id) || state.projects[0];
}

export function todoById(state, id) {
  return state.todos.find((todo) => todo.id === id) || state.todos[0];
}

export function todosForProject(state, projectId) {
  return state.todos.filter((todo) => todo.projectId === projectId);
}

export function filterTodos(todos, { status = "all", ownerId = "all", query = "" } = {}) {
  const normalized = query.trim().toLowerCase();
  return todos.filter((todo) => {
    if (status === "open" && todo.done) return false;
    if (status === "done" && !todo.done) return false;
    if (ownerId !== "all" && todo.ownerId !== ownerId) return false;
    return !normalized || `${todo.title} ${todo.notes}`.toLowerCase().includes(normalized);
  });
}

export function quickFind(state, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const projectResults = state.projects.map((project) => ({ type: "Project", id: project.id, title: project.name, subtitle: project.note, target: { view: "project", projectId: project.id } }));
  const peopleResults = people.map((person) => ({ type: "Person", id: person.id, title: person.name, subtitle: person.role, target: { view: "aggregate", aggregateId: "activity", personId: person.id } }));
  const todoResults = state.todos.map((todo) => ({ type: "To-do", id: todo.id, title: todo.title, subtitle: projectById(state, todo.projectId).name, target: { view: "todo", projectId: todo.projectId, toolId: "todos", todoId: todo.id } }));
  const pageResults = aggregateViews.map((view) => ({ type: "Page", id: view.id, title: view.title, subtitle: view.eyebrow, target: { view: "aggregate", aggregateId: view.id } }));
  return [...projectResults, ...peopleResults, ...todoResults, ...pageResults]
    .filter((item) => `${item.title} ${item.subtitle} ${item.type}`.toLowerCase().includes(needle))
    .slice(0, 8);
}

export function toggleProjectStar(state, projectId) {
  return { ...state, projects: state.projects.map((project) => project.id === projectId ? { ...project, starred: !project.starred } : project) };
}

export function createProject(state, { name, note = "", access = "All-access" }) {
  const id = `project-${state.nextId}`;
  return { ...state, nextId: state.nextId + 1, projects: [...state.projects, { id, name: name.trim(), note: note.trim(), access, starred: true, color: "green", people: ["geoff"] }] };
}

export function createFolder(state, name) {
  const id = `folder-${state.nextId}`;
  return { ...state, nextId: state.nextId + 1, folders: [...state.folders, { id, name: name.trim(), projectIds: [] }] };
}

export function createTodo(state, { projectId, listId = "next", title, ownerId = "geoff", due = "", dueLabel = "No due date" }) {
  const id = `todo-${state.nextId}`;
  const todo = { id, projectId, listId, title: title.trim(), ownerId, due, dueLabel, done: false, createdBy: "geoff", createdLabel: "Today", notes: "", bookmarked: false, subtasks: [], comments: [] };
  return { ...state, nextId: state.nextId + 1, todos: [...state.todos, todo] };
}

export function updateTodo(state, todoId, patch) {
  return { ...state, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, ...patch } : todo) };
}

export function toggleTodo(state, todoId) {
  return { ...state, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, done: !todo.done } : todo) };
}

export function toggleTodoBookmark(state, todoId) {
  return { ...state, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, bookmarked: !todo.bookmarked } : todo) };
}

export function addSubtask(state, todoId, title, ownerId = "geoff") {
  const id = `subtask-${state.nextId}`;
  return { ...state, nextId: state.nextId + 1, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, subtasks: [...todo.subtasks, { id, title: title.trim(), ownerId, done: false }] } : todo) };
}

export function toggleSubtask(state, todoId, subtaskId) {
  return { ...state, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, subtasks: todo.subtasks.map((subtask) => subtask.id === subtaskId ? { ...subtask, done: !subtask.done } : subtask) } : todo) };
}

export function addComment(state, todoId, body, authorId = "geoff") {
  const id = `comment-${state.nextId}`;
  return { ...state, nextId: state.nextId + 1, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, comments: [...todo.comments, { id, authorId, time: "Just now", body: body.trim() }] } : todo) };
}

export function removeComment(state, todoId, commentId) {
  return { ...state, todos: state.todos.map((todo) => todo.id === todoId ? { ...todo, comments: todo.comments.filter((comment) => comment.id !== commentId) } : todo) };
}

export function addToolItem(state, toolId, value) {
  return { ...state, toolItems: { ...state.toolItems, [toolId]: [value.trim(), ...(state.toolItems[toolId] || [])] } };
}

export function addMessageThread(state, { projectId, title, category = "Updates" }) {
  const thread = { id: `message-${state.nextId}`, projectId, title: title.trim(), category, pinned: false, authorId: "geoff", updated: "Just now", body: "New message ready for the project discussion.", replies: [] };
  return { ...state, nextId: state.nextId + 1, messageThreads: [thread, ...state.messageThreads] };
}

export function addMessageReply(state, threadId, body, authorId = "geoff") {
  const reply = { id: `reply-${state.nextId}`, authorId, time: "Just now", body: body.trim() };
  return { ...state, nextId: state.nextId + 1, messageThreads: state.messageThreads.map((thread) => thread.id === threadId ? { ...thread, updated: "Just now", replies: [...thread.replies, reply] } : thread) };
}

export function addDocument(state, { projectId, title, type = "Document" }) {
  const document = { id: `doc-${state.nextId}`, projectId, title: title.trim(), type, folder: "Uploads", updated: "Just now", summary: "New shared reference material for this project." };
  return { ...state, nextId: state.nextId + 1, documents: [document, ...state.documents] };
}

export function addChatMessage(state, projectId, body, authorId = "geoff") {
  const message = { id: `chat-${state.nextId}`, projectId, authorId, time: "Just now", body: body.trim() };
  return { ...state, nextId: state.nextId + 1, chatMessages: [...state.chatMessages, message] };
}

export function addScheduleEvent(state, { projectId, title, date, time = "9:00am", kind = "Event" }) {
  const event = { id: `event-${state.nextId}`, projectId, title: title.trim(), date, dateLabel: date || "No date", time, kind };
  return { ...state, nextId: state.nextId + 1, scheduleEvents: [...state.scheduleEvents, event].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function addWorkflowCard(state, { projectId, title, columnId = "new" }) {
  const card = { id: `card-${state.nextId}`, projectId, title: title.trim(), columnId, ownerId: "geoff" };
  return { ...state, nextId: state.nextId + 1, workflowCards: [...state.workflowCards, card] };
}

export function moveWorkflowCard(state, cardId, targetColumnId) {
  return { ...state, workflowCards: state.workflowCards.map((card) => card.id === cardId ? { ...card, columnId: targetColumnId } : card) };
}

export function addHillUpdate(state, summary) {
  const update = { id: `hill-${state.nextId}`, label: "Just now", summary: summary.trim() };
  return { ...state, nextId: state.nextId + 1, hillUpdates: [update, ...state.hillUpdates] };
}

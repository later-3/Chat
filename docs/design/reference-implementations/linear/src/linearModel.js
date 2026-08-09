export const people = [
  { id: "maya", name: "Maya Chen", initials: "MC", color: "violet" },
  { id: "roman", name: "Roman Hale", initials: "RH", color: "cyan" },
  { id: "sara", name: "Sara Kim", initials: "SK", color: "amber" },
  { id: "noah", name: "Noah Williams", initials: "NW", color: "green" },
];

const issues = [
  { id: "issue-342", key: "LIN-342", title: "Ship the new command menu", status: "In progress", priority: "High", assigneeId: "maya", cycle: "Cycle 45", label: "Feature", estimate: 5, projectId: "atlas", description: "Replace the legacy action search with a faster command menu that keeps keyboard context and supports project actions.", created: "Jul 18", updated: "18 min ago" },
  { id: "issue-338", key: "LIN-338", title: "Improve offline recovery messaging", status: "In review", priority: "Medium", assigneeId: "roman", cycle: "Cycle 45", label: "Reliability", estimate: 3, projectId: "atlas", description: "Explain which edits are safely cached and which commands need a connection before they can be submitted.", created: "Jul 16", updated: "1h ago" },
  { id: "issue-331", key: "LIN-331", title: "Audit mobile issue properties", status: "Todo", priority: "No priority", assigneeId: "sara", cycle: "Cycle 45", label: "Mobile", estimate: 2, projectId: "atlas", description: "Review field order, touch targets, focus behavior, and the handoff from issue preview to the full mobile detail surface.", created: "Jul 14", updated: "3h ago" },
  { id: "issue-327", key: "LIN-327", title: "Add project update reminders", status: "In progress", priority: "Urgent", assigneeId: "noah", cycle: "Cycle 44", label: "Projects", estimate: 5, projectId: "atlas", description: "Notify the project lead when the weekly update is due without turning the reminder into a false health judgment.", created: "Jul 11", updated: "Yesterday" },
  { id: "issue-319", key: "LIN-319", title: "Preserve filters after split-view navigation", status: "Done", priority: "Medium", assigneeId: "maya", cycle: "Cycle 44", label: "Views", estimate: 3, projectId: "atlas", description: "Keep list filters and scroll position stable when opening and closing a temporary detail surface.", created: "Jul 8", updated: "2d ago" },
  { id: "issue-314", key: "LIN-314", title: "Document project health definitions", status: "Canceled", priority: "Low", assigneeId: "roman", cycle: "Cycle 44", label: "Docs", estimate: 1, projectId: "atlas", description: "Write shared definitions for On track, At risk, and Off track so project leads apply the signal consistently.", created: "Jul 5", updated: "3d ago" },
];

const projects = [
  { id: "atlas", name: "Atlas workspace refresh", summary: "Make planning and project updates easier to scan without losing depth.", status: "In progress", leadId: "maya", targetDate: "Sep 12", progress: 64, teams: ["Product", "Engineering"], updateSchedule: { mode: "default", frequency: "Every week", day: "Monday", time: "11:00–12:00" } },
  { id: "relay", name: "Relay reliability", summary: "Reduce interrupted work and make recovery behavior legible.", status: "In progress", leadId: "roman", targetDate: "Oct 03", progress: 41, teams: ["Infrastructure"], updateSchedule: { mode: "custom", frequency: "Every 2 weeks", day: "Thursday", time: "15:00–16:00" } },
  { id: "mobile", name: "Mobile parity", summary: "Bring the core issue workflow to small screens without copying desktop density.", status: "Planned", leadId: "sara", targetDate: "Nov 21", progress: 18, teams: ["Mobile"], updateSchedule: { mode: "never", frequency: "Every week", day: "Monday", time: "11:00–12:00" } },
];

const updates = [
  { id: "update-atlas-3", projectId: "atlas", health: "at-risk", authorId: "maya", created: "Today at 9:42am", takeaway: "Navigation is stable; update reminders need one more pass.", body: "The new list and Peek navigation is holding up in testing. We are keeping the Sep 12 target, but reminders are one review behind because we found cases where an automated prompt looked like a project-health judgment.\n\nNext we will finish the reminder copy, validate focus restoration, and run the small-screen review.", observedChanges: ["Progress increased from 52% to 64%", "LIN-319 completed", "Target date unchanged"], comments: [{ id: "comment-1", authorId: "roman", body: "I can review the reminder failure states this afternoon.", created: "24 min ago" }], reactions: { "eyes": 3, "rocket": 2 }, published: true },
  { id: "update-relay-2", projectId: "relay", health: "on-track", authorId: "roman", created: "Yesterday", takeaway: "Recovery traces are now available in the main debugging path.", body: "We connected recovery traces to the main debugging path and removed the duplicate connection state. The remaining work is focused on outcome-unknown copy and operator handoff.", observedChanges: ["Milestone Recovery trace completed", "Progress increased from 33% to 41%"], comments: [], reactions: { "eyes": 1, "rocket": 4 }, published: true },
  { id: "update-mobile-1", projectId: "mobile", health: "on-track", authorId: "sara", created: "Jul 31", takeaway: "The first mobile issue-flow study is complete.", body: "The mobile study supports a full-width detail surface rather than shrinking the desktop Peek. We are documenting the field order and touch requirements before implementation.", observedChanges: ["Project moved from Backlog to Planned"], comments: [], reactions: { "eyes": 2, "rocket": 1 }, published: true },
  { id: "update-atlas-2", projectId: "atlas", health: "on-track", authorId: "maya", created: "Jul 28", takeaway: "The interaction model is ready for implementation.", body: "The team agreed on three reading speeds: list scanning, temporary Peek, and full issue detail. Implementation starts with shared object identity and predictable return paths.", observedChanges: ["Project lead changed to Maya Chen", "Target date set to Sep 12"], comments: [], reactions: { "eyes": 2, "rocket": 3 }, published: true },
];

export function createInitialState() {
  return {
    issues: structuredClone(issues),
    projects: structuredClone(projects),
    updates: structuredClone(updates),
    draft: null,
    userFeeds: [{ id: "feed-risk", name: "At risk projects", health: "at-risk" }],
    nextId: 100,
  };
}

export function personById(id) {
  return people.find((person) => person.id === id) || people[0];
}

export function issueById(state, id) {
  return state.issues.find((issue) => issue.id === id) || state.issues[0];
}

export function projectById(state, id) {
  return state.projects.find((project) => project.id === id) || state.projects[0];
}

export function updatesForProject(state, projectId) {
  return state.updates.filter((update) => update.projectId === projectId && update.published);
}

export function updateIssue(state, issueId, patch) {
  return { ...state, issues: state.issues.map((issue) => issue.id === issueId ? { ...issue, ...patch } : issue) };
}

export function startManualDraft(state, projectId) {
  return { ...state, draft: { id: `draft-${state.nextId}`, projectId, source: "human", status: "candidate", health: "on-track", body: "", sources: [], observedChanges: [] }, nextId: state.nextId + 1 };
}

export function createAgentDraft(state, projectId) {
  return {
    ...state,
    draft: {
      id: `draft-${state.nextId}`,
      projectId,
      source: "agent",
      status: "candidate",
      health: "at-risk",
      body: "The command menu and split-view navigation are stable in the current build. Update reminders need one more review because automated prompts must not look like a project-health judgment.\n\nNext, refine reminder language, validate focus restoration, and complete the mobile review.",
      sources: ["6 issues changed since the last update", "Project brief", "#p-atlas Slack summary"],
      observedChanges: ["Progress increased from 52% to 64%", "LIN-319 completed", "Target date unchanged"],
    },
    nextId: state.nextId + 1,
  };
}

export function editDraft(state, patch) {
  if (!state.draft) return state;
  return { ...state, draft: { ...state.draft, ...patch, status: "edited" } };
}

export function discardDraft(state) {
  return { ...state, draft: null };
}

export function publishDraft(state, authorId = "maya") {
  if (!state.draft?.body.trim()) return state;
  const update = {
    id: `update-${state.nextId}`,
    projectId: state.draft.projectId,
    health: state.draft.health,
    authorId,
    created: "Just now",
    takeaway: state.draft.body.trim().split(/\n|\./)[0],
    body: state.draft.body.trim(),
    observedChanges: state.draft.observedChanges,
    comments: [],
    reactions: { eyes: 0, rocket: 0 },
    published: true,
    assistedByAgent: state.draft.source === "agent",
  };
  return { ...state, draft: null, nextId: state.nextId + 1, updates: [update, ...state.updates] };
}

export function addUpdateComment(state, updateId, body, authorId = "maya") {
  const comment = { id: `comment-${state.nextId}`, authorId, body: body.trim(), created: "Just now" };
  return { ...state, nextId: state.nextId + 1, updates: state.updates.map((update) => update.id === updateId ? { ...update, comments: [...update.comments, comment] } : update) };
}

export function reactToUpdate(state, updateId, reaction) {
  return { ...state, updates: state.updates.map((update) => update.id === updateId ? { ...update, reactions: { ...update.reactions, [reaction]: (update.reactions[reaction] || 0) + 1 } } : update) };
}

export function setUpdateSchedule(state, projectId, schedule) {
  return { ...state, projects: state.projects.map((project) => project.id === projectId ? { ...project, updateSchedule: { ...schedule } } : project) };
}

export function pulseUpdates(state, feed = "for-me") {
  const published = state.updates.filter((update) => update.published);
  if (feed === "popular") return published.slice().sort((a, b) => Object.values(b.reactions).reduce((sum, value) => sum + value, 0) - Object.values(a.reactions).reduce((sum, value) => sum + value, 0));
  if (feed === "recent") return published;
  if (feed.startsWith("custom:")) {
    const custom = state.userFeeds.find((item) => `custom:${item.id}` === feed);
    return custom ? published.filter((update) => update.health === custom.health) : published;
  }
  return published.filter((update) => ["atlas", "relay"].includes(update.projectId));
}

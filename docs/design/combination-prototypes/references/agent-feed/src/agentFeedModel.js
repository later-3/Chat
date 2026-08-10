export const agents = [
  {
    id: "project-pilot",
    name: "Project Pilot",
    role: "Plans and advances project work",
    image: "/assets/agent-feed/agent-orbit.png",
    color: "#c94f32",
    state: "running",
  },
  {
    id: "evidence-scout",
    name: "Evidence Scout",
    role: "Finds sources and checks provenance",
    image: "/assets/agent-feed/agent-lantern.png",
    color: "#a86f00",
    state: "waiting",
  },
  {
    id: "release-guardian",
    name: "Release Guardian",
    role: "Verifies releases and side effects",
    image: "/assets/agent-feed/agent-shield.png",
    color: "#00796b",
    state: "reconciling",
  },
  {
    id: "research-navigator",
    name: "Research Navigator",
    role: "Synthesizes product references",
    image: "/assets/agent-feed/agent-compass.png",
    color: "#5146a4",
    state: "idle",
  },
];

export const projects = [
  { id: "project-solution", name: "Project Solution", code: "PS", color: "#5b5fc7" },
  { id: "design-research", name: "Design Research", code: "DR", color: "#c94f32" },
  { id: "release-readiness", name: "Release Readiness", code: "RR", color: "#00796b" },
  { id: "personal-studio", name: "Personal Studio", code: "PL", color: "#a86f00" },
];

const evidence = {
  retry: [
    "Run 14 stopped after the provider accepted the request",
    "The command is idempotent only after the product commit",
    "Revision 7 changes the retry boundary, not the user outcome",
  ],
  calendar: [
    "Day, Week, Year and profile interactions passed browser QA",
    "Scenario coverage records Take, Adapt and Refuse decisions",
  ],
};

export const initialFeedItems = [
  {
    id: "task-decision-retry",
    type: "decision",
    status: "needs_attention",
    agentId: "project-pilot",
    projectId: "project-solution",
    title: "Approve the external retry boundary",
    summary: "A policy decision is blocking the next Project Solution iteration.",
    body: "Project Pilot found that a normal retry could duplicate an accepted provider command. Review revision 7 before the run can continue.",
    updatedAt: "2026-08-09T10:42:00+08:00",
    relativeTime: "12 min ago",
    priority: "high",
    category: "Decision required",
    revision: 7,
    hash: "8fe1…5c2a",
    relatedLabel: "Decision · External side-effect policy",
    evidence: evidence.retry,
  },
  {
    id: "task-assistance-source",
    type: "assistance",
    status: "needs_attention",
    agentId: "evidence-scout",
    projectId: "design-research",
    title: "Confirm access to the Agent Feed source record",
    summary: "The research run needs one permission check before it can cite the record.",
    body: "Open the related source, confirm it contains no participant-private content, then mark this assistance task complete.",
    updatedAt: "2026-08-09T10:24:00+08:00",
    relativeTime: "30 min ago",
    priority: "medium",
    category: "Assistance requested",
    relatedLabel: "Evidence · Microsoft Agent Feed permissions",
    steps: ["Open the related source", "Check the permission warning", "Complete this task"],
  },
  {
    id: "task-data-project-update",
    type: "data_entry",
    status: "needs_attention",
    agentId: "project-pilot",
    projectId: "project-solution",
    title: "Review the weekly Project Update",
    summary: "A structured update is ready to accept or dismiss.",
    body: "The update is still a candidate. Edit the fields below, then explicitly accept it into the project record.",
    updatedAt: "2026-08-09T09:58:00+08:00",
    relativeTime: "56 min ago",
    priority: "medium",
    category: "Data entry",
    relatedLabel: "Project Update · Week 32",
    candidate: {
      health: "At risk",
      summary: "The interaction reference is on track; the retry boundary decision is still blocking execution.",
      nextStep: "Approve revision 7, then start the vertical implementation slice.",
    },
  },
  {
    id: "task-outcome-unknown",
    type: "outcome_unknown",
    status: "outcome_unknown",
    agentId: "release-guardian",
    projectId: "release-readiness",
    title: "Reconcile an unknown deployment outcome",
    summary: "The connection dropped after the provider accepted the command.",
    body: "Do not retry. Query the provider using the idempotency identity and reconcile its result with the Product Store.",
    updatedAt: "2026-08-09T09:37:00+08:00",
    relativeTime: "1 hr ago",
    priority: "critical",
    category: "Run needs reconciliation",
    relatedLabel: "Run · deploy-preview-019f",
    commandId: "cmd_019f83a",
    providerReference: "pending lookup",
  },
  {
    id: "task-review-hey",
    type: "review",
    status: "completed",
    agentId: "research-navigator",
    projectId: "design-research",
    title: "HEY Calendar reference was frozen",
    summary: "The time-scale reference passed scenario and visual QA.",
    body: "This is an informational review item. No approval is required because the freeze commit already owns the result.",
    updatedAt: "2026-08-09T08:48:00+08:00",
    relativeTime: "2 hr ago",
    priority: "low",
    category: "Review completed work",
    completedBy: "agent",
    outcome: "succeeded",
    relatedLabel: "Reference · HEY Calendar",
    evidence: evidence.calendar,
  },
  {
    id: "task-complete-scope",
    type: "assistance",
    status: "completed",
    agentId: "project-pilot",
    projectId: "project-solution",
    title: "Confirm PS2 scope boundaries",
    summary: "You clarified that Stage, Milestone and Update belong in the next slice.",
    body: "The waiting planning run resumed with the approved scope and preserved the original project context.",
    updatedAt: "2026-08-08T18:16:00+08:00",
    relativeTime: "Yesterday",
    priority: "medium",
    category: "Assistance completed",
    completedBy: "user",
    outcome: "succeeded",
    relatedLabel: "Work · PS2 task boundary",
  },
  {
    id: "task-review-snapshot",
    type: "review",
    status: "completed",
    agentId: "evidence-scout",
    projectId: "design-research",
    title: "Official source snapshot refreshed",
    summary: "The Agent Feed documentation was rechecked against the July release plan.",
    body: "The snapshot records the preview status, Power Apps MCP dependency and permission warning.",
    updatedAt: "2026-08-08T16:40:00+08:00",
    relativeTime: "Yesterday",
    priority: "low",
    category: "Review completed work",
    completedBy: "agent",
    outcome: "succeeded",
    relatedLabel: "Evidence · Official source snapshot",
  },
  {
    id: "task-decision-context",
    type: "decision",
    status: "completed",
    agentId: "project-pilot",
    projectId: "project-solution",
    title: "Planning context package approved",
    summary: "Revision 3 was approved with two user edits.",
    body: "The workflow resumed using the approved version and hash. The candidate text did not become a fact until approval.",
    updatedAt: "2026-08-08T14:03:00+08:00",
    relativeTime: "Yesterday",
    priority: "high",
    category: "Decision approved",
    completedBy: "user",
    outcome: "succeeded",
    revision: 3,
    hash: "4c91…a8be",
    relatedLabel: "Decision · Planning context",
  },
  {
    id: "task-dismissed-personal",
    type: "data_entry",
    status: "completed",
    agentId: "research-navigator",
    projectId: "personal-studio",
    title: "Weekend reading suggestion dismissed",
    summary: "The candidate did not match the current Personal Studio focus.",
    body: "Dismissal is retained as a task outcome; no reading item was created.",
    updatedAt: "2026-08-07T19:20:00+08:00",
    relativeTime: "2 days ago",
    priority: "low",
    category: "Candidate dismissed",
    completedBy: "user",
    outcome: "dismissed",
    relatedLabel: "Candidate · Weekend reading",
  },
];

const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };

export function getAgent(id) {
  return agents.find((agent) => agent.id === id);
}

export function getProject(id) {
  return projects.find((project) => project.id === id);
}

export function selectFeedItems(items, { tab = "needs", agentId = "all", projectId = "all" } = {}) {
  return items
    .filter((item) => (tab === "completed" ? item.status === "completed" : item.status !== "completed"))
    .filter((item) => agentId === "all" || item.agentId === agentId)
    .filter((item) => projectId === "all" || item.projectId === projectId)
    .sort((left, right) => {
      const risk = riskOrder[left.priority] - riskOrder[right.priority];
      return risk || new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf();
    });
}

export function getActionSet(item) {
  if (!item || item.status === "completed" || item.status === "in_progress" || item.status === "reconciling") return [];
  if (item.type === "decision") return ["approve", "request_changes"];
  if (item.type === "assistance") return ["complete"];
  if (item.type === "data_entry") return ["accept", "dismiss"];
  if (item.type === "outcome_unknown") return ["reconcile"];
  return [];
}

function completedItem(item, patch) {
  return {
    ...item,
    ...patch,
    status: "completed",
    relativeTime: "Just now",
    updatedAt: new Date().toISOString(),
  };
}

export function transitionFeedItem(items, itemId, action, payload = {}) {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) return { items, notice: "Task not found" };

  const allowed = getActionSet(item);
  if (!allowed.includes(action)) return { items, notice: "Action is not available for this task" };

  let nextItem;
  let notice;
  if (action === "approve") {
    nextItem = completedItem(item, { outcome: "approved", completedBy: "user", category: "Decision approved" });
    notice = "Decision approved. The waiting run can resume.";
  } else if (action === "request_changes") {
    nextItem = { ...item, status: "in_progress", category: "Agent revising", userNote: payload.note || "Revise against the recorded evidence.", relativeTime: "Just now" };
    notice = "Changes requested. Project Pilot is revising the candidate.";
  } else if (action === "complete") {
    nextItem = completedItem(item, { outcome: "succeeded", completedBy: "user", category: "Assistance completed" });
    notice = "Assistance completed. The waiting agent can continue.";
  } else if (action === "accept") {
    nextItem = completedItem(item, { outcome: "accepted", completedBy: "user", category: "Update accepted", accepted: payload });
    notice = "Project Update accepted into the related record.";
  } else if (action === "dismiss") {
    nextItem = completedItem(item, { outcome: "dismissed", completedBy: "user", category: "Candidate dismissed" });
    notice = "Candidate dismissed. No project fact was created.";
  } else {
    nextItem = { ...item, status: "reconciling", category: "Reconciling with provider", relativeTime: "Just now" };
    notice = "Reconciliation started. No retry was sent.";
  }

  return {
    items: items.map((candidate) => (candidate.id === itemId ? nextItem : candidate)),
    notice,
  };
}

export function finishReconciliation(items, itemId) {
  return items.map((item) =>
    item.id === itemId && item.status === "reconciling"
      ? completedItem(item, {
          outcome: "succeeded",
          completedBy: "system",
          category: "Outcome reconciled",
          providerReference: "deployment dep_84319 exists",
        })
      : item,
  );
}

export function getSummary(items) {
  return {
    needs: items.filter((item) => item.status !== "completed").length,
    completed: items.filter((item) => item.status === "completed").length,
    running: agents.filter((agent) => agent.state === "running" || agent.state === "reconciling").length,
  };
}

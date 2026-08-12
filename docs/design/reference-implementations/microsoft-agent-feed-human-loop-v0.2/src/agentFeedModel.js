export const agents = [
  {
    id: "project-pilot",
    name: "Project Pilot",
    role: "Plans and advances project work",
    image: "/assets/agent-orbit.png",
    color: "#c94f32",
  },
  {
    id: "evidence-scout",
    name: "Evidence Scout",
    role: "Finds sources and checks provenance",
    image: "/assets/agent-lantern.png",
    color: "#a86f00",
  },
  {
    id: "release-guardian",
    name: "Release Guardian",
    role: "Verifies releases and side effects",
    image: "/assets/agent-shield.png",
    color: "#00796b",
  },
  {
    id: "research-navigator",
    name: "Research Navigator",
    role: "Synthesizes product references",
    image: "/assets/agent-compass.png",
    color: "#5146a4",
  },
];

export const projects = [
  { id: "project-solution", name: "Project Solution", code: "PS", color: "#5b5fc7" },
  { id: "design-research", name: "Design Research", code: "DR", color: "#c94f32" },
  { id: "release-readiness", name: "Release Readiness", code: "RR", color: "#00796b" },
  { id: "personal-studio", name: "Personal Studio", code: "PL", color: "#a86f00" },
];

export const evidenceCatalog = [
  { id: "ev-run-14", label: "Run 14 checkpoint", kind: "Run evidence", source: "Product Run" },
  { id: "ev-provider-contract", label: "Provider idempotency contract", kind: "Contract", source: "Release Readiness" },
  { id: "ev-policy-v7", label: "Policy revision 7", kind: "Decision candidate", source: "Project Solution" },
  { id: "ev-provider-ledger", label: "Provider query ledger", kind: "Provider evidence", source: "Release Guardian" },
  { id: "ev-agent-feed-permissions", label: "Agent Feed permission warning", kind: "Source record", source: "Design Research" },
  { id: "ev-reference-matrix", label: "Reference scenario matrix", kind: "Research evidence", source: "Design Research" },
  { id: "ev-delegated-source", label: "Official supervision source excerpt", kind: "Delegated evidence", source: "Evidence Scout" },
];

export const resourceCatalog = [
  { id: "resource-source-record", label: "Microsoft Agent Feed source record", kind: "Evidence record" },
  { id: "resource-permission-log", label: "Participant visibility check", kind: "Permission result" },
  { id: "resource-audit-note", label: "Research audit note", kind: "Project document" },
];

export const feedbackRequirements = [
  { id: "no-blind-retry", label: "Remove ordinary Retry from outcome_unknown" },
  { id: "bind-provider-evidence", label: "Bind the decision to provider-query Evidence" },
  { id: "show-resume-gate", label: "Show the Product Commit before Run resume" },
  { id: "narrow-scope", label: "Limit scope to one waiting deployment Run" },
];

const initialDecisionTimeline = [
  { id: "decision-candidate", label: "Revision 7 submitted", detail: "Project Pilot · candidate only", state: "succeeded" },
  { id: "decision-wait", label: "Waiting on human decision", detail: "Human owns the next step", state: "waiting" },
];

const initialAssistanceTimeline = [
  { id: "source-check", label: "Source access check", detail: "Evidence Scout found a permission gap", state: "succeeded" },
  { id: "assistance-wait", label: "Waiting on human assistance", detail: "Context or an access result is required", state: "waiting" },
];

const initialOutcomeTimeline = [
  { id: "command-sent", label: "Command sent", detail: "Provider accepted the request", state: "succeeded" },
  { id: "response-lost", label: "Response lost", detail: "No Product Commit was recorded", state: "failed" },
  { id: "outcome-wait", label: "Outcome unknown", detail: "Reconcile; do not Retry", state: "waiting" },
];

const initialDelegationTimeline = [
  { id: "gap-found", label: "Evidence gap detected", detail: "Project Pilot cannot finish the source claim", state: "succeeded" },
  { id: "delegate-ready", label: "Delegation ready", detail: "Human may delegate, redirect, or stop", state: "waiting" },
];

export const initialFeedItems = [
  {
    id: "task-decision-retry",
    type: "decision",
    status: "waiting_human",
    agentId: "project-pilot",
    projectId: "project-solution",
    title: "Approve the external retry boundary",
    summary: "Revision 7 is blocking one waiting deployment Run.",
    body: "Project Pilot found that an ordinary retry could duplicate a provider command. Review the exact revision, scope, and Evidence before the Run can continue.",
    updatedAt: "2026-08-11T10:42:00+08:00",
    relativeTime: "12 min ago",
    priority: "high",
    category: "Decision required",
    revision: 7,
    hash: "8fe1…5c2a",
    scope: "One waiting deployment Run",
    relatedLabel: "Decision · External side-effect policy",
    evidenceIds: ["ev-run-14", "ev-provider-contract", "ev-policy-v7"],
    policyText: "Retry the provider command after a transport failure when the Product Store has no final result.",
    run: {
      id: "run-policy-14",
      state: "waiting_human",
      nextOwner: "Human",
      timeline: initialDecisionTimeline,
    },
    decisionFacts: [],
    feedbackHistory: [],
  },
  {
    id: "task-assistance-source",
    type: "assistance",
    status: "waiting_human",
    agentId: "evidence-scout",
    projectId: "design-research",
    title: "Confirm access to the Agent Feed source record",
    summary: "The research Run needs context and one permission result.",
    body: "Evidence Scout paused because the source record may contain participant-private content. Add context, select safe resources, or record the manual access result.",
    updatedAt: "2026-08-11T10:24:00+08:00",
    relativeTime: "30 min ago",
    priority: "medium",
    category: "Assistance requested",
    relatedLabel: "Evidence · Microsoft Agent Feed permissions",
    request: {
      reason: "Permission and source material missing",
      requested: ["Context for the visibility boundary", "A safe source record", "Manual access outcome"],
    },
    run: {
      id: "run-research-22",
      state: "waiting_human",
      nextOwner: "Human",
      timeline: initialAssistanceTimeline,
    },
  },
  {
    id: "task-data-project-update",
    type: "candidate",
    status: "candidate_editable",
    agentId: "project-pilot",
    projectId: "project-solution",
    title: "Review the weekly Project Update",
    summary: "A structured Project Update candidate is ready to edit.",
    body: "The Update is a candidate. Its health, summary, and next step remain editable until you Accept or Dismiss it.",
    updatedAt: "2026-08-11T09:58:00+08:00",
    relativeTime: "56 min ago",
    priority: "medium",
    category: "Editable candidate",
    relatedLabel: "Project Update · Week 32",
    generation: 1,
    candidate: {
      health: "At risk",
      summary: "The interaction reference is on track; the retry boundary decision is still blocking execution.",
      nextStep: "Approve revision 7, then start the vertical implementation slice.",
    },
    sources: ["Run run-policy-14", "Decision candidate revision 7"],
    observedChanges: ["Agent Feed mobile overflow reproduced", "Provider Retry boundary remains unresolved"],
  },
  {
    id: "task-outcome-unknown",
    type: "outcome_unknown",
    status: "outcome_unknown",
    agentId: "release-guardian",
    projectId: "release-readiness",
    title: "Reconcile an unknown deployment outcome",
    summary: "The response was lost after the provider accepted the command.",
    body: "Do not retry. Query the provider using the same command identity, inspect the returned Evidence, then commit the Product fact or record a manual disposition.",
    updatedAt: "2026-08-11T09:37:00+08:00",
    relativeTime: "1 hr ago",
    priority: "critical",
    category: "Outcome unknown",
    relatedLabel: "Run · deploy-preview-019f",
    commandId: "cmd_019f83a",
    requestHash: "5ac0…90f1",
    providerHint: "Deployment API · region west-eu",
    providerReference: "No query performed",
    productState: "No deployment fact committed",
    evidenceIds: ["ev-provider-contract"],
    run: {
      id: "run-deploy-019f",
      state: "outcome_unknown",
      nextOwner: "Human",
      timeline: initialOutcomeTimeline,
    },
  },
  {
    id: "task-delegation-evidence",
    type: "delegation",
    status: "delegation_ready",
    agentId: "project-pilot",
    projectId: "design-research",
    title: "Delegate the missing supervision Evidence",
    summary: "Project Pilot needs Evidence Scout before the parent task can continue.",
    body: "The parent task is blocked on a source claim. Delegate a bounded Evidence search, then watch ownership and dependency move back to Project Pilot.",
    updatedAt: "2026-08-11T09:20:00+08:00",
    relativeTime: "1 hr ago",
    priority: "medium",
    category: "Delegation proposed",
    relatedLabel: "Work · Agent supervision evidence",
    parentTask: { id: "work-reference-31", label: "Validate Agent supervision claims", ownerAgentId: "project-pilot" },
    dependency: { id: "dep-evidence-31", label: "Official source evidence", state: "missing" },
    currentOwnerAgentId: "project-pilot",
    participants: ["project-pilot", "evidence-scout"],
    coordinationMessages: [],
    evidenceIds: [],
    run: {
      id: "run-delegation-31",
      state: "waiting_human",
      nextOwner: "Human",
      timeline: initialDelegationTimeline,
    },
  },
  {
    id: "task-review-hey",
    type: "review",
    status: "succeeded",
    agentId: "research-navigator",
    projectId: "design-research",
    title: "HEY Calendar reference was frozen",
    summary: "The time-scale reference passed scenario and visual QA.",
    body: "This is an informational result. No approval action is shown because the freeze record already owns the fact.",
    updatedAt: "2026-08-11T08:48:00+08:00",
    relativeTime: "2 hr ago",
    priority: "low",
    category: "Completed",
    outcome: "succeeded",
    completedBy: "agent",
    relatedLabel: "Reference · HEY Calendar",
    evidenceIds: ["ev-reference-matrix"],
  },
  {
    id: "task-failed-verification",
    type: "run_result",
    status: "failed",
    agentId: "release-guardian",
    projectId: "release-readiness",
    title: "Mobile verification failed",
    summary: "The previous layout exceeded the 391 px viewport.",
    body: "The Run ended as failed. No success fact was created; a new Run is required after the layout is fixed.",
    updatedAt: "2026-08-10T17:10:00+08:00",
    relativeTime: "Yesterday",
    priority: "high",
    category: "Failed",
    outcome: "failed",
    relatedLabel: "Run · mobile-qa-18",
    evidenceIds: [],
  },
  {
    id: "task-dismissed-personal",
    type: "candidate",
    status: "dismissed",
    agentId: "research-navigator",
    projectId: "personal-studio",
    title: "Weekend reading suggestion dismissed",
    summary: "The candidate did not match the current Personal Studio focus.",
    body: "The dismissed object remains read only. Starting again creates a new candidate identity.",
    updatedAt: "2026-08-10T16:20:00+08:00",
    relativeTime: "Yesterday",
    priority: "low",
    category: "Dismissed",
    outcome: "dismissed",
    relatedLabel: "Candidate · Weekend reading",
    generation: 1,
    candidate: {
      health: "On track",
      summary: "Read two sources about autonomous supervision.",
      nextStep: "Add one item to Weekend reading.",
    },
    sources: ["Research Navigator suggestion"],
    observedChanges: [],
  },
  {
    id: "task-reconciled-history",
    type: "outcome_unknown",
    status: "reconciled",
    agentId: "release-guardian",
    projectId: "release-readiness",
    title: "Preview deployment reconciled",
    summary: "Provider query confirmed one deployment and one Product Commit.",
    body: "The reconciliation fact is final in this fixture and has no generic Undo.",
    updatedAt: "2026-08-10T14:03:00+08:00",
    relativeTime: "Yesterday",
    priority: "medium",
    category: "Reconciled",
    outcome: "reconciled",
    completedBy: "system",
    relatedLabel: "Run · deploy-preview-019e",
    commandId: "cmd_019e29d",
    providerReference: "deployment dep_84277 exists",
    productState: "Deployment fact committed",
    evidenceIds: ["ev-provider-ledger"],
  },
];

export const terminalStatuses = new Set(["succeeded", "failed", "canceled", "dismissed", "reconciled"]);
export const attentionStatuses = new Set(["waiting_human", "candidate_editable", "outcome_unknown", "reconciliation_found", "delegation_ready"]);
export const activeStatuses = new Set(["waiting_agent", "decision_committed", "resuming", "running", "reconciling", "delegated", "evidence_returned"]);

const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };

export function cloneInitialFeedItems() {
  return JSON.parse(JSON.stringify(initialFeedItems));
}

export function getAgent(id) {
  return agents.find((agent) => agent.id === id);
}

export function getProject(id) {
  return projects.find((project) => project.id === id);
}

export function getEvidence(id) {
  return evidenceCatalog.find((entry) => entry.id === id);
}

export function groupForStatus(status) {
  if (attentionStatuses.has(status)) return "attention";
  if (activeStatuses.has(status)) return "active";
  return "history";
}

export function selectFeedItems(items, { tab = "attention", agentId = "all", projectId = "all" } = {}) {
  return items
    .filter((item) => groupForStatus(item.status) === tab)
    .filter((item) => agentId === "all" || item.agentId === agentId || item.currentOwnerAgentId === agentId)
    .filter((item) => projectId === "all" || item.projectId === projectId)
    .sort((left, right) => {
      const risk = riskOrder[left.priority] - riskOrder[right.priority];
      return risk || new Date(right.updatedAt).valueOf() - new Date(left.updatedAt).valueOf();
    });
}

export function getSummary(items) {
  return {
    attention: items.filter((item) => attentionStatuses.has(item.status)).length,
    active: items.filter((item) => activeStatuses.has(item.status)).length,
    history: items.filter((item) => terminalStatuses.has(item.status)).length,
    runningAgents: new Set(
      items
        .filter((item) => activeStatuses.has(item.status))
        .map((item) => item.currentOwnerAgentId || item.agentId),
    ).size,
  };
}

export function getHumanActionSet(item) {
  if (!item) return [];
  if (item.type === "decision" && item.status === "waiting_human") return ["approve_decision", "submit_feedback"];
  if (item.type === "assistance" && item.status === "waiting_human") return ["submit_assistance"];
  if (item.type === "candidate" && item.status === "candidate_editable") return ["accept_candidate", "dismiss_candidate"];
  if (item.type === "candidate" && item.status === "dismissed") return ["create_new_candidate"];
  if (item.type === "outcome_unknown" && item.status === "outcome_unknown") return ["start_reconciliation"];
  if (item.type === "outcome_unknown" && item.status === "reconciliation_found") return ["commit_reconciliation", "manual_disposition"];
  if (item.type === "delegation" && item.status === "delegation_ready") return ["delegate"];
  if (item.type === "delegation" && ["delegated", "evidence_returned"].includes(item.status)) return ["add_direction", "reassign", "stop_delegation"];
  return [];
}

export function getSystemActionSet(item) {
  if (!item) return [];
  if (item.type === "decision" && item.status === "waiting_agent") return ["agent_return_revision"];
  if (item.type === "decision" && item.status === "decision_committed") return ["resume_decision_run"];
  if (item.type === "decision" && item.status === "resuming") return ["execute_decision_run"];
  if (item.type === "decision" && item.status === "running") return ["complete_decision_run", "fail_decision_run"];
  if (item.type === "assistance" && item.status === "waiting_agent") return ["resume_assistance_run"];
  if (item.type === "assistance" && item.status === "running") return ["complete_assistance_run", "fail_assistance_run"];
  if (item.type === "outcome_unknown" && item.status === "reconciling") return ["reconciliation_found"];
  if (item.type === "delegation" && item.status === "delegated") return ["scout_return"];
  if (item.type === "delegation" && item.status === "evidence_returned") return ["pilot_consume"];
  return [];
}

function appendTimeline(item, entry, runPatch = {}) {
  return {
    ...item,
    run: {
      ...item.run,
      ...runPatch,
      timeline: [...(item.run?.timeline || []), entry],
    },
  };
}

function replaceTimelineWaiting(timeline) {
  return timeline.map((entry) => (entry.state === "waiting" ? { ...entry, state: "succeeded" } : entry));
}

function commandError(code, message, items) {
  return { ok: false, code, error: message, items };
}

function commandSuccess(items, item, notice, extras = {}) {
  return { ok: true, items, item, notice, ...extras };
}

function replaceItem(items, nextItem) {
  return items.map((item) => (item.id === nextItem.id ? nextItem : item));
}

function validateRevision(item, payload) {
  if (payload.expectedRevision !== item.revision || payload.expectedHash !== item.hash) {
    return "The Decision revision or hash is stale.";
  }
  return null;
}

function applyDecisionTransition(items, item, action, payload) {
  if (action === "submit_feedback") {
    const stale = validateRevision(item, payload);
    if (stale) return commandError("stale_decision", stale, items);
    if (!payload.note?.trim()) return commandError("feedback_note_required", "Add free-text feedback.", items);
    if (!payload.requirementIds?.length) return commandError("feedback_requirement_required", "Select at least one structured change.", items);
    if (!payload.evidenceIds?.length) return commandError("feedback_evidence_required", "Select at least one Evidence item.", items);
    const feedback = {
      id: `feedback-${item.feedbackHistory.length + 1}`,
      note: payload.note.trim(),
      requirementIds: [...payload.requirementIds],
      evidenceIds: [...payload.evidenceIds],
      scope: payload.scope || item.scope,
      attachmentName: payload.attachmentName || null,
      submittedBy: "Later",
      state: "submitted",
    };
    let next = {
      ...item,
      status: "waiting_agent",
      category: "Agent revising",
      relativeTime: "Just now",
      latestFeedback: feedback,
      feedbackHistory: [...item.feedbackHistory, feedback],
    };
    next = appendTimeline(
      { ...next, run: { ...next.run, timeline: replaceTimelineWaiting(next.run.timeline) } },
      { id: `feedback-${item.feedbackHistory.length + 1}`, label: "Structured feedback submitted", detail: "Project Pilot owns the next step", state: "succeeded" },
      { state: "waiting_agent", nextOwner: "Project Pilot" },
    );
    next = appendTimeline(next, { id: `agent-revising-${item.revision}`, label: "Agent revising", detail: `Preparing revision ${item.revision + 1}`, state: "waiting" });
    return commandSuccess(replaceItem(items, next), next, "Feedback submitted. Project Pilot is preparing a new revision.");
  }

  if (action === "agent_return_revision") {
    const nextRevision = item.revision + 1;
    const nextHash = nextRevision === 8 ? "b47c…e910" : `rev${nextRevision}…a221`;
    const selectedEvidence = item.latestFeedback.evidenceIds;
    const evidenceIds = [...new Set([...selectedEvidence, "ev-provider-ledger"])];
    const responses = [
      ...item.latestFeedback.requirementIds.map((id) => ({
        requirementId: id,
        label: feedbackRequirements.find((entry) => entry.id === id)?.label || id,
        response: "Addressed in the policy and Run gate below.",
        state: "addressed",
      })),
      {
        requirementId: "free-text",
        label: "Free-text feedback",
        response: `Applied: ${item.latestFeedback.note}`,
        state: "addressed",
      },
    ];
    let next = {
      ...item,
      status: "waiting_human",
      category: `Revision ${nextRevision} ready`,
      revision: nextRevision,
      hash: nextHash,
      scope: item.latestFeedback.scope,
      evidenceIds,
      previousRevision: {
        revision: item.revision,
        hash: item.hash,
        policyText: item.policyText,
      },
      policyText: "Never repeat an outcome_unknown provider command. Query by command identity, commit the reconciled Product fact, then resume the waiting Run.",
      diff: {
        from: item.policyText,
        to: "Never repeat an outcome_unknown provider command. Query by command identity, commit the reconciled Product fact, then resume the waiting Run.",
      },
      agentResponses: responses,
      relativeTime: "Just now",
    };
    next = {
      ...next,
      run: {
        ...next.run,
        state: "waiting_human",
        nextOwner: "Human",
        timeline: replaceTimelineWaiting(next.run.timeline),
      },
    };
    next = appendTimeline(next, { id: `revision-${nextRevision}`, label: `Revision ${nextRevision} returned`, detail: "New hash and Evidence recorded", state: "succeeded" });
    next = appendTimeline(next, { id: `decision-wait-${nextRevision}`, label: "Waiting on human decision", detail: "Approve or request another revision", state: "waiting" });
    return commandSuccess(replaceItem(items, next), next, `Revision ${nextRevision} is ready with a new hash and Evidence.`);
  }

  if (action === "approve_decision") {
    const stale = validateRevision(item, payload);
    if (stale) return commandError("stale_decision", stale, items);
    const decisionFact = {
      id: `decision-fact-${item.revision}`,
      revision: item.revision,
      hash: item.hash,
      scope: item.scope,
      evidenceIds: [...item.evidenceIds],
      decidedBy: "Later",
      outcome: "approved",
    };
    let next = {
      ...item,
      status: "decision_committed",
      category: "Decision fact committed",
      decisionFacts: [...item.decisionFacts, decisionFact],
      relativeTime: "Just now",
    };
    next = {
      ...next,
      run: { ...next.run, state: "decision_committed", nextOwner: "Chat", timeline: replaceTimelineWaiting(next.run.timeline) },
    };
    next = appendTimeline(next, { id: `decision-commit-${item.revision}`, label: "Decision fact committed", detail: `Revision ${item.revision} · ${item.hash}`, state: "succeeded" });
    return commandSuccess(replaceItem(items, next), next, "Decision fact committed. The Run has not resumed yet.");
  }

  if (action === "resume_decision_run") {
    let next = { ...item, status: "resuming", category: "Run resuming" };
    next = appendTimeline(next, { id: "resume-hook", label: "Resume accepted", detail: "Waiting Workflow resumed after Product Commit", state: "succeeded" }, { state: "resuming", nextOwner: "Workflow" });
    return commandSuccess(replaceItem(items, next), next, "The waiting Run resumed from its checkpoint.");
  }

  if (action === "execute_decision_run") {
    let next = { ...item, status: "running", category: "Run executing" };
    next = appendTimeline(next, { id: "policy-execution", label: "Validate retry boundary", detail: "No provider command repeated", state: "running" }, { state: "running", nextOwner: "Project Pilot" });
    return commandSuccess(replaceItem(items, next), next, "Project Pilot is executing the approved revision.");
  }

  if (action === "complete_decision_run") {
    const timeline = item.run.timeline.map((entry) => (entry.state === "running" ? { ...entry, state: "succeeded" } : entry));
    let next = {
      ...item,
      status: "succeeded",
      outcome: "succeeded",
      category: "Completed",
      completedBy: "system",
      finalRecord: {
        id: "policy-record-external-side-effect",
        state: "committed",
        revision: item.revision,
        hash: item.hash,
        result: "Unknown external results require reconciliation before any new command.",
      },
      run: { ...item.run, timeline },
    };
    next = appendTimeline(next, { id: "product-result", label: "Authoritative policy record written", detail: "Run succeeded", state: "succeeded" }, { state: "succeeded", nextOwner: "None" });
    return commandSuccess(replaceItem(items, next), next, "Run succeeded and the authoritative policy record was written.");
  }

  if (action === "fail_decision_run") {
    let next = { ...item, status: "failed", outcome: "failed", category: "Failed" };
    next = appendTimeline(next, { id: "execution-failed", label: "Execution failed", detail: "No final policy result was written", state: "failed" }, { state: "failed", nextOwner: "Human" });
    return commandSuccess(replaceItem(items, next), next, "Run failed. No success fact was created.");
  }

  return commandError("invalid_transition", "Decision action is not valid in this state.", items);
}

function applyAssistanceTransition(items, item, action, payload) {
  if (action === "submit_assistance") {
    if (!payload.context?.trim()) return commandError("assistance_context_required", "Add the context the Agent should receive.", items);
    if (!payload.resourceIds?.length) return commandError("assistance_resource_required", "Select at least one resource.", items);
    if (!["access_confirmed", "source_still_restricted"].includes(payload.manualResult)) return commandError("assistance_result_required", "Record the manual result.", items);
    const submission = {
      context: payload.context.trim(),
      resourceIds: [...payload.resourceIds],
      manualResult: payload.manualResult,
      attachmentName: payload.attachmentName || null,
    };
    let next = {
      ...item,
      status: "waiting_agent",
      category: "Agent confirming assistance",
      assistanceSubmission: submission,
      agentReceipt: {
        receivedContext: submission.context,
        receivedResources: submission.resourceIds.map((id) => resourceCatalog.find((entry) => entry.id === id)?.label || id),
        receivedManualResult: submission.manualResult,
        attachmentName: submission.attachmentName,
      },
      relativeTime: "Just now",
    };
    next = {
      ...next,
      run: { ...next.run, timeline: replaceTimelineWaiting(next.run.timeline), state: "waiting_agent", nextOwner: "Evidence Scout" },
    };
    next = appendTimeline(next, { id: `assistance-${item.reinterventionCount || 0}`, label: "Assistance submitted", detail: "Evidence Scout confirmed the received inputs", state: "succeeded" });
    next = appendTimeline(next, { id: `assistance-agent-${item.reinterventionCount || 0}`, label: "Agent validating inputs", detail: "Agent owns the next step", state: "waiting" });
    return commandSuccess(replaceItem(items, next), next, "Assistance submitted. Evidence Scout confirmed what it received.");
  }

  if (action === "resume_assistance_run") {
    let next = { ...item, status: "running", category: "Run resumed" };
    next = { ...next, run: { ...next.run, timeline: replaceTimelineWaiting(next.run.timeline) } };
    next = appendTimeline(next, { id: "assistance-resume", label: "Research Run resumed", detail: "Checking the selected resources", state: "running" }, { state: "running", nextOwner: "Evidence Scout" });
    return commandSuccess(replaceItem(items, next), next, "The research Run resumed with the submitted assistance.");
  }

  if (action === "complete_assistance_run") {
    const timeline = item.run.timeline.map((entry) => (entry.state === "running" ? { ...entry, state: "succeeded" } : entry));
    if (item.assistanceSubmission.manualResult === "source_still_restricted") {
      let next = {
        ...item,
        status: "waiting_human",
        category: "More assistance required",
        summary: "The selected source is still restricted; the Agent needs a safe excerpt or a stop decision.",
        reinterventionCount: (item.reinterventionCount || 0) + 1,
        run: { ...item.run, timeline },
      };
      next = appendTimeline(next, { id: `assistance-reblocked-${next.reinterventionCount}`, label: "Source remains restricted", detail: "Human owns the next step again", state: "waiting" }, { state: "waiting_human", nextOwner: "Human" });
      return commandSuccess(replaceItem(items, next), next, "The Agent needs another human intervention; the Run did not claim success.");
    }
    let next = {
      ...item,
      status: "succeeded",
      outcome: "succeeded",
      category: "Completed",
      finalRecord: {
        id: "evidence-agent-feed-permission",
        state: "verified",
        result: "The selected source contains no participant-private content.",
        resourceIds: [...item.assistanceSubmission.resourceIds],
      },
      run: { ...item.run, timeline },
    };
    next = appendTimeline(next, { id: "assistance-result", label: "Evidence record updated", detail: "Research Run succeeded", state: "succeeded" }, { state: "succeeded", nextOwner: "None" });
    return commandSuccess(replaceItem(items, next), next, "The Run succeeded and wrote the verified Evidence result.");
  }

  if (action === "fail_assistance_run") {
    let next = { ...item, status: "failed", outcome: "failed", category: "Failed" };
    next = appendTimeline(next, { id: "assistance-failed", label: "Resource validation failed", detail: "No Evidence fact was created", state: "failed" }, { state: "failed", nextOwner: "Human" });
    return commandSuccess(replaceItem(items, next), next, "The assistance Run failed without creating a verified Evidence fact.");
  }

  return commandError("invalid_transition", "Assistance action is not valid in this state.", items);
}

function validateCandidate(payload) {
  if (!["On track", "At risk", "Off track"].includes(payload.health)) return "Choose a valid Health value.";
  if (!payload.summary?.trim()) return "Summary is required.";
  if (!payload.nextStep?.trim()) return "Next step is required.";
  return null;
}

function applyCandidateTransition(items, item, action, payload) {
  if (action === "accept_candidate") {
    const error = validateCandidate(payload);
    if (error) return commandError("candidate_invalid", error, items);
    const accepted = { health: payload.health, summary: payload.summary.trim(), nextStep: payload.nextStep.trim() };
    const next = {
      ...item,
      status: "succeeded",
      outcome: "accepted",
      category: "Accepted",
      accepted,
      finalRecord: { id: `project-update-week-32-g${item.generation}`, state: "published", ...accepted },
      relativeTime: "Just now",
    };
    return commandSuccess(replaceItem(items, next), next, "Project Update accepted as a read-only authoritative record.");
  }
  if (action === "dismiss_candidate") {
    const next = { ...item, status: "dismissed", outcome: "dismissed", category: "Dismissed", relativeTime: "Just now" };
    return commandSuccess(replaceItem(items, next), next, "Candidate dismissed. No Project Update fact was created.");
  }
  if (action === "create_new_candidate") {
    const generation = (item.generation || 1) + 1;
    const created = {
      ...item,
      id: `${item.id}-g${generation}`,
      status: "candidate_editable",
      outcome: undefined,
      category: "Editable candidate",
      generation,
      title: `Review Project Update candidate ${generation}`,
      summary: "A new candidate was created; the dismissed object remains unchanged.",
      finalRecord: undefined,
      accepted: undefined,
      relativeTime: "Just now",
      candidate: {
        health: "On track",
        summary: "A fresh Project Update candidate is ready for review.",
        nextStep: "Review the new observed changes and publish only if accurate.",
      },
      observedChanges: ["New candidate identity created after dismissal"],
    };
    return commandSuccess([...items, created], created, "A new candidate was created with a new identity.", { createdItemId: created.id });
  }
  return commandError("invalid_transition", "Candidate action is not valid in this state.", items);
}

function applyOutcomeTransition(items, item, action, payload) {
  if (action === "start_reconciliation") {
    let next = { ...item, status: "reconciling", category: "Reconciling", relativeTime: "Just now" };
    next = { ...next, run: { ...next.run, timeline: replaceTimelineWaiting(next.run.timeline) } };
    next = appendTimeline(next, { id: "provider-query", label: "Query provider by command identity", detail: `${item.commandId} · no new command sent`, state: "running" }, { state: "reconciling", nextOwner: "Release Guardian" });
    return commandSuccess(replaceItem(items, next), next, "Reconciliation started. No Retry was sent.");
  }
  if (action === "reconciliation_found") {
    const timeline = item.run.timeline.map((entry) => (entry.state === "running" ? { ...entry, state: "succeeded" } : entry));
    let next = {
      ...item,
      status: "reconciliation_found",
      category: "Provider result found",
      providerReference: "deployment dep_84319 exists · succeeded",
      queryEvidence: {
        request: `GET deployment by ${item.commandId}`,
        response: "One deployment exists; checksum matches the original request",
        evidenceId: "ev-provider-ledger",
      },
      evidenceIds: [...new Set([...item.evidenceIds, "ev-provider-ledger"])],
      run: { ...item.run, timeline },
    };
    next = appendTimeline(next, { id: "provider-result", label: "Provider result found", detail: "Human must choose Product Commit or manual disposition", state: "waiting" }, { state: "waiting_human", nextOwner: "Human" });
    return commandSuccess(replaceItem(items, next), next, "Provider evidence found. Product state is still uncommitted.");
  }
  if (action === "commit_reconciliation") {
    const next = {
      ...item,
      status: "reconciled",
      outcome: "reconciled",
      category: "Reconciled",
      productState: "Deployment fact committed",
      finalRecord: {
        id: "deployment-dep-84319",
        state: "succeeded",
        commandId: item.commandId,
        requestHash: item.requestHash,
        providerReference: item.providerReference,
        evidenceIds: [...item.evidenceIds],
      },
      run: {
        ...item.run,
        state: "reconciled",
        nextOwner: "None",
        timeline: [
          ...replaceTimelineWaiting(item.run.timeline),
          { id: "reconcile-commit", label: "Product fact committed", detail: "Reconciliation is final; no Undo", state: "succeeded" },
        ],
      },
    };
    return commandSuccess(replaceItem(items, next), next, "Reconciliation committed as an authoritative Product fact.");
  }
  if (action === "manual_disposition") {
    if (!payload.note?.trim()) return commandError("manual_note_required", "Record the manual disposition.", items);
    const next = {
      ...item,
      status: "canceled",
      outcome: "manual_disposition",
      category: "Manual disposition",
      manualDisposition: payload.note.trim(),
      run: {
        ...item.run,
        state: "canceled",
        nextOwner: "None",
        timeline: [
          ...replaceTimelineWaiting(item.run.timeline),
          { id: "manual-disposition", label: "Manual disposition recorded", detail: payload.note.trim(), state: "succeeded" },
        ],
      },
    };
    return commandSuccess(replaceItem(items, next), next, "Manual disposition recorded; no Product success fact was created.");
  }
  return commandError("invalid_transition", "Reconciliation action is not valid in this state.", items);
}

function coordinationMessage(from, to, body) {
  return {
    id: `coord-${Math.random().toString(36).slice(2, 9)}`,
    from,
    to,
    body,
    visibility: "Project participants",
    authoritativeFact: false,
  };
}

function applyDelegationTransition(items, item, action, payload) {
  if (action === "delegate") {
    let next = {
      ...item,
      status: "delegated",
      category: "Delegated",
      currentOwnerAgentId: "evidence-scout",
      delegatedTask: {
        id: "delegated-evidence-31",
        label: "Find an official supervision source",
        parentTaskId: item.parentTask.id,
        ownerAgentId: "evidence-scout",
        state: "running",
      },
      dependency: { ...item.dependency, state: "in_progress" },
      coordinationMessages: [
        ...item.coordinationMessages,
        coordinationMessage("project-pilot", "evidence-scout", "Find a source that proves typed supervision without treating the Feed as the fact source."),
      ],
      relativeTime: "Just now",
    };
    next = { ...next, run: { ...next.run, timeline: replaceTimelineWaiting(next.run.timeline) } };
    next = appendTimeline(next, { id: "delegated-task", label: "Evidence Scout delegated task created", detail: "Parent task waits on delegated Evidence", state: "running" }, { state: "delegated", nextOwner: "Evidence Scout" });
    return commandSuccess(replaceItem(items, next), next, "Delegated task created. Evidence Scout owns the dependency.");
  }
  if (action === "scout_return") {
    const timeline = item.run.timeline.map((entry) => (entry.state === "running" ? { ...entry, state: "succeeded" } : entry));
    let next = {
      ...item,
      status: "evidence_returned",
      category: "Evidence returned",
      currentOwnerAgentId: "project-pilot",
      delegatedTask: { ...item.delegatedTask, state: "succeeded" },
      dependency: { ...item.dependency, state: "satisfied" },
      evidenceIds: [...new Set([...item.evidenceIds, "ev-delegated-source"])],
      coordinationMessages: [
        ...item.coordinationMessages,
        coordinationMessage("evidence-scout", "project-pilot", "Returned the official source excerpt with provenance and permission boundary."),
      ],
      run: { ...item.run, timeline },
    };
    next = appendTimeline(next, { id: "scout-return", label: "Evidence Scout returned material", detail: "Ownership returned to Project Pilot", state: "succeeded" }, { state: "evidence_returned", nextOwner: "Project Pilot" });
    next = appendTimeline(next, { id: "pilot-consume-wait", label: "Project Pilot consuming Evidence", detail: "Agent owns the next step", state: "running" });
    return commandSuccess(replaceItem(items, next), next, "Evidence Scout returned material; Project Pilot is consuming it.");
  }
  if (action === "pilot_consume") {
    const timeline = item.run.timeline.map((entry) => (entry.state === "running" ? { ...entry, state: "succeeded" } : entry));
    const next = {
      ...item,
      status: "succeeded",
      outcome: "succeeded",
      category: "Completed",
      currentOwnerAgentId: "project-pilot",
      coordinationMessages: [
        ...item.coordinationMessages,
        coordinationMessage("project-pilot", "evidence-scout", "Evidence consumed. The parent task can continue."),
      ],
      finalRecord: {
        id: item.parentTask.id,
        state: "unblocked",
        result: "Official supervision Evidence attached to the parent Work.",
        evidenceIds: [...item.evidenceIds],
      },
      run: { ...item.run, timeline, state: "succeeded", nextOwner: "None" },
    };
    return commandSuccess(replaceItem(items, next), next, "Project Pilot consumed the delegated Evidence and continued the parent task.");
  }
  if (action === "add_direction") {
    if (!payload.note?.trim()) return commandError("direction_required", "Add a direction for the current owner.", items);
    const next = {
      ...item,
      humanDirections: [...(item.humanDirections || []), payload.note.trim()],
      coordinationMessages: [
        ...item.coordinationMessages,
        coordinationMessage("Later", item.currentOwnerAgentId, payload.note.trim()),
      ],
    };
    return commandSuccess(replaceItem(items, next), next, "Human direction added as a coordination event, not a Product fact.");
  }
  if (action === "reassign") {
    if (!agents.some((agent) => agent.id === payload.agentId)) return commandError("agent_required", "Choose a valid Agent.", items);
    const next = {
      ...item,
      status: "delegated",
      category: "Reassigned",
      currentOwnerAgentId: payload.agentId,
      delegatedTask: { ...item.delegatedTask, ownerAgentId: payload.agentId, state: "running" },
      participants: [...new Set([...item.participants, payload.agentId])],
      coordinationMessages: [
        ...item.coordinationMessages,
        coordinationMessage("Later", payload.agentId, "The delegated task was reassigned by a human participant."),
      ],
      run: { ...item.run, state: "delegated", nextOwner: getAgent(payload.agentId).name },
    };
    return commandSuccess(replaceItem(items, next), next, `Delegated task reassigned to ${getAgent(payload.agentId).name}.`);
  }
  if (action === "stop_delegation") {
    const next = {
      ...item,
      status: "canceled",
      outcome: "canceled",
      category: "Canceled",
      delegatedTask: item.delegatedTask ? { ...item.delegatedTask, state: "canceled" } : undefined,
      dependency: { ...item.dependency, state: "unresolved" },
      run: {
        ...item.run,
        state: "canceled",
        nextOwner: "None",
        timeline: [
          ...item.run.timeline.map((entry) => (entry.state === "running" || entry.state === "waiting" ? { ...entry, state: "canceled" } : entry)),
          { id: "delegation-stopped", label: "Delegation stopped by human", detail: "Parent task remains blocked", state: "canceled" },
        ],
      },
    };
    return commandSuccess(replaceItem(items, next), next, "Delegation stopped. The parent task remains blocked.");
  }
  return commandError("invalid_transition", "Delegation action is not valid in this state.", items);
}

export function applyTransition(items, itemId, action, payload = {}) {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) return commandError("not_found", "Feed item not found.", items);
  const allowed = [...getHumanActionSet(item), ...getSystemActionSet(item)];
  if (!allowed.includes(action)) return commandError("invalid_transition", `Action ${action} is not available from ${item.status}.`, items);

  if (item.type === "decision") return applyDecisionTransition(items, item, action, payload);
  if (item.type === "assistance") return applyAssistanceTransition(items, item, action, payload);
  if (item.type === "candidate") return applyCandidateTransition(items, item, action, payload);
  if (item.type === "outcome_unknown") return applyOutcomeTransition(items, item, action, payload);
  if (item.type === "delegation") return applyDelegationTransition(items, item, action, payload);
  return commandError("invalid_transition", "This informational item has no state-changing action.", items);
}

export function getRecordProjection(item) {
  const objectType = item.relatedLabel?.split(" · ")[0] || "Record";
  return {
    objectType,
    label: item.relatedLabel,
    project: getProject(item.projectId)?.name,
    owner: "Chat Product Store fixture",
    state: item.finalRecord?.state || item.productState || item.status,
    revision: item.finalRecord?.revision || item.revision || null,
    hash: item.finalRecord?.hash || item.hash || null,
    runId: item.run?.id || (objectType === "Run" ? item.relatedLabel?.split(" · ")[1] : null),
    decisionFacts: item.decisionFacts || [],
    evidenceIds: item.finalRecord?.evidenceIds || item.evidenceIds || [],
    result: item.finalRecord?.result || item.manualDisposition || null,
  };
}

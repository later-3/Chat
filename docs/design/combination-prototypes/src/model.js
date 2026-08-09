const prototypeFixture = {
  workspace: {
    id: "workspace_chat_reference_combinations",
    name: "Later 的 Chat",
  },
  participants: [
    {
      id: "participant_later",
      name: "Later",
      kind: "human",
      role: "Owner",
      visibility: "private_workspace",
      consent: "required_for_external_share",
    },
    {
      id: "agent_aju",
      name: "阿橘",
      kind: "agent",
      role: "项目推进",
      visibility: "project_members",
      consent: "human_accepts_candidates",
    },
    {
      id: "agent_mochi",
      name: "墨尺",
      kind: "agent",
      role: "证据核验",
      visibility: "project_members",
      consent: "read_scoped_resources_only",
    },
    {
      id: "agent_zhuri",
      name: "逐日",
      kind: "agent",
      role: "运行看护",
      visibility: "owner_only",
      consent: "external_side_effect_requires_decision",
    },
  ],
  projects: [
    {
      id: "project_chat_solution",
      name: "Chat · Project Solution",
      shortName: "Project Solution",
      category: "work",
      goal: "让长期 Project、决定、证据与执行在跨天协作中保持连续。",
      health: "on_track",
      leadId: "participant_later",
      stage: "交互收口",
      stageIndex: 2,
      milestone: "组合原型冻结",
      milestoneDue: "8 月 14 日",
      iteration: "Iteration 02 · 监督与证据",
      cadence: "每周一、四更新",
      workIds: ["work_project_room", "work_evidence_contract", "work_memory_reconciliation"],
      resourceIds: ["resource_project_ledger", "resource_reference_audits"],
      participantIds: ["participant_later", "agent_aju", "agent_mochi", "agent_zhuri"],
    },
    {
      id: "project_ceramic_studio",
      name: "生活 · 陶艺工作室",
      shortName: "陶艺工作室",
      category: "life",
      goal: "完成第一套可日用的青白釉早餐器皿。",
      health: "at_risk",
      leadId: "participant_later",
      stage: "釉色测试",
      stageIndex: 1,
      milestone: "4 只可用器皿",
      milestoneDue: "9 月 6 日",
      iteration: "Iteration 04 · 小样烧制",
      cadence: "周日晚复盘",
      workIds: ["work_glaze_tests"],
      resourceIds: ["resource_glaze_notebook"],
      participantIds: ["participant_later", "agent_mochi"],
    },
    {
      id: "project_trail_half",
      name: "爱好 · 秋季越野半马",
      shortName: "秋季越野半马",
      category: "hobby",
      goal: "安全完成 21 km 山地路线，并保留可持续训练节奏。",
      health: "on_track",
      leadId: "participant_later",
      stage: "耐力构建",
      stageIndex: 1,
      milestone: "连续 14 km 训练",
      milestoneDue: "8 月 30 日",
      iteration: "Iteration 03 · 爬升适应",
      cadence: "每周日更新",
      workIds: ["work_route_recon"],
      resourceIds: ["resource_route_map"],
      participantIds: ["participant_later", "agent_zhuri"],
    },
  ],
  works: [
    {
      id: "work_project_room",
      projectId: "project_chat_solution",
      title: "统一 Project Room 的对象层级",
      ownerId: "agent_aju",
      status: "active",
      scopeIds: ["scope_project_structure"],
      resourceIds: ["resource_project_ledger"],
      updatedAt: "今天 10:40",
    },
    {
      id: "work_evidence_contract",
      projectId: "project_chat_solution",
      title: "冻结 Evidence 与 Decision 合同",
      ownerId: "agent_mochi",
      status: "needs_decision",
      scopeIds: ["scope_decision_integrity"],
      resourceIds: ["resource_reference_audits"],
      updatedAt: "今天 11:12",
    },
    {
      id: "work_memory_reconciliation",
      projectId: "project_chat_solution",
      title: "对账日历发布结果",
      ownerId: "agent_zhuri",
      status: "blocked",
      scopeIds: ["scope_runtime_reconciliation"],
      resourceIds: ["resource_calendar_receipt"],
      updatedAt: "今天 11:26",
    },
    {
      id: "work_glaze_tests",
      projectId: "project_ceramic_studio",
      title: "完成第二轮青白釉小样",
      ownerId: "participant_later",
      status: "active",
      scopeIds: ["scope_glaze_samples"],
      resourceIds: ["resource_glaze_notebook"],
      updatedAt: "昨天 21:10",
    },
    {
      id: "work_route_recon",
      projectId: "project_trail_half",
      title: "复核周末长距离路线",
      ownerId: "participant_later",
      status: "active",
      scopeIds: ["scope_route_safety"],
      resourceIds: ["resource_route_map"],
      updatedAt: "周六 08:20",
    },
  ],
  scopes: [
    {
      id: "scope_project_structure",
      workId: "work_project_room",
      title: "Project → Stage → Iteration → Work",
      actionIds: ["action_publish_owner_update"],
    },
    {
      id: "scope_decision_integrity",
      workId: "work_evidence_contract",
      title: "版本绑定与证据可追溯",
      actionIds: ["action_review_evidence_contract"],
    },
    {
      id: "scope_runtime_reconciliation",
      workId: "work_memory_reconciliation",
      title: "结果未知只走查询对账",
      actionIds: ["action_query_calendar_receipt"],
    },
    {
      id: "scope_glaze_samples",
      workId: "work_glaze_tests",
      title: "小样记录与窑烧",
      actionIds: ["action_log_glaze_sample"],
    },
    {
      id: "scope_route_safety",
      workId: "work_route_recon",
      title: "路线与补给检查",
      actionIds: ["action_check_route_water"],
    },
  ],
  actions: [
    {
      id: "action_publish_owner_update",
      scopeId: "scope_project_structure",
      projectId: "project_chat_solution",
      title: "发布负责人 Update",
      status: "open",
      reversible: true,
      dayPart: "day",
      scheduledFor: "today",
      ownerId: "participant_later",
    },
    {
      id: "action_review_evidence_contract",
      scopeId: "scope_decision_integrity",
      projectId: "project_chat_solution",
      title: "复核 Evidence 合同候选",
      status: "open",
      reversible: true,
      dayPart: "day",
      scheduledFor: "today",
      ownerId: "participant_later",
    },
    {
      id: "action_query_calendar_receipt",
      scopeId: "scope_runtime_reconciliation",
      projectId: "project_chat_solution",
      title: "查询外部日历回执",
      status: "open",
      reversible: false,
      dayPart: "day",
      scheduledFor: "today",
      ownerId: "agent_zhuri",
    },
    {
      id: "action_log_glaze_sample",
      scopeId: "scope_glaze_samples",
      projectId: "project_ceramic_studio",
      title: "记录 6 号釉片配方",
      status: "open",
      reversible: true,
      dayPart: "evening",
      scheduledFor: "today",
      ownerId: "participant_later",
    },
    {
      id: "action_check_route_water",
      scopeId: "scope_route_safety",
      projectId: "project_trail_half",
      title: "确认 12 km 补水点",
      status: "open",
      reversible: true,
      dayPart: "day",
      scheduledFor: "today",
      ownerId: "participant_later",
    },
  ],
  updates: [
    {
      id: "update_project_solution_r7",
      projectId: "project_chat_solution",
      revision: 7,
      health: "on_track",
      title: "对象身份已经稳定，正在收口三种注意力模式",
      body: "Project Room 承担长期连续性，Today 只投影个人节奏，Workbench 只处理证据与监督。三个模式共享对象 ID，不重复拥有事实。",
      authorId: "participant_later",
      publishedAt: "今天 10:40",
      evidenceIds: ["evidence_six_reference_audits"],
    },
    {
      id: "update_ceramic_r4",
      projectId: "project_ceramic_studio",
      revision: 4,
      health: "at_risk",
      title: "釉色接近目标，但窑温记录仍不完整",
      body: "第二批小样中 2 片颜色稳定；本周先补齐温区记录，不扩大器型。",
      authorId: "participant_later",
      publishedAt: "昨天 21:10",
      evidenceIds: ["evidence_glaze_photo_log"],
    },
    {
      id: "update_trail_r3",
      projectId: "project_trail_half",
      revision: 3,
      health: "on_track",
      title: "爬升适应正常，周末只增加距离不增加速度",
      body: "本周最长 11 km，恢复正常。下一次训练验证补水点与下坡技术。",
      authorId: "participant_later",
      publishedAt: "周日 18:20",
      evidenceIds: ["evidence_route_recon"],
    },
  ],
  resources: [
    {
      id: "resource_project_ledger",
      title: "Project Ledger v5",
      kind: "artifact",
      provenance: "Chat Product Store · formal",
      visibility: "project_members",
      evidenceIds: ["evidence_project_ledger_revision"],
    },
    {
      id: "resource_reference_audits",
      title: "6 个冻结参考交互审计",
      kind: "source_bundle",
      provenance: "官方资料 + 冻结原型 QA",
      visibility: "project_members",
      evidenceIds: ["evidence_six_reference_audits"],
    },
    {
      id: "resource_calendar_receipt",
      title: "日历供应商请求回执",
      kind: "external_receipt",
      provenance: "Provider request id · redacted",
      visibility: "owner_only",
      evidenceIds: ["evidence_calendar_provider_query"],
    },
    {
      id: "resource_glaze_notebook",
      title: "青白釉试片笔记",
      kind: "personal_note",
      provenance: "Later · 手工记录",
      visibility: "owner_only",
      evidenceIds: ["evidence_glaze_photo_log"],
    },
    {
      id: "resource_route_map",
      title: "龙井山径路线图",
      kind: "external_map",
      provenance: "个人收藏 · 只读链接",
      visibility: "owner_only",
      evidenceIds: ["evidence_route_recon"],
    },
  ],
  evidence: [
    {
      id: "evidence_project_ledger_revision",
      title: "Ledger schema revision 5",
      source: "Product Store",
      observedAt: "今天 09:48",
      integrity: "verified",
    },
    {
      id: "evidence_six_reference_audits",
      title: "6 / 6 冻结原型与审计记录",
      source: "Reference worktrees",
      observedAt: "今天 11:12",
      integrity: "verified",
    },
    {
      id: "evidence_calendar_provider_query",
      title: "Provider 查询尚未返回确定结果",
      source: "Calendar API",
      observedAt: "今天 11:26",
      integrity: "outcome_unknown",
    },
    {
      id: "evidence_glaze_photo_log",
      title: "第二批试片照片与窑温记录",
      source: "Later",
      observedAt: "昨天 21:02",
      integrity: "partial",
    },
    {
      id: "evidence_route_recon",
      title: "路线踏勘与补水点记录",
      source: "Later",
      observedAt: "周六 08:20",
      integrity: "verified",
    },
  ],
  decisions: [
    {
      id: "decision_combination_freeze_r4",
      projectId: "project_chat_solution",
      title: "冻结 3 个互斥注意力模式",
      content: "采用 Project Room、Today Rhythm、Evidence Workbench；不设置跨模式重复导航。",
      revision: 4,
      hash: "sha256:9f82d1a46c1e",
      status: "candidate",
      impact: "冻结组合原型的信息架构",
      createdById: "agent_aju",
      participantIds: ["participant_later", "agent_aju", "agent_mochi"],
      visibility: "project_members",
      consent: "owner_acceptance_required",
      evidenceIds: ["evidence_six_reference_audits"],
    },
  ],
  candidates: [
    {
      id: "candidate_evidence_summary_r2",
      projectId: "project_chat_solution",
      title: "Evidence 合同摘要候选",
      content: "Resource 保存可复用材料，Evidence 保存某次判断可引用的观察；候选不能自动晋升为长期事实。",
      revision: 2,
      status: "candidate",
      createdById: "agent_mochi",
      visibility: "project_members",
      consent: "human_review_required",
      evidenceIds: ["evidence_project_ledger_revision", "evidence_six_reference_audits"],
    },
  ],
  runs: [
    {
      id: "run_calendar_publish_attempt_02",
      projectId: "project_chat_solution",
      title: "发布组合评审日历事件",
      agentId: "agent_zhuri",
      status: "outcome_unknown",
      reconciliation: "idle",
      undoAllowed: false,
      externalId: "calendar-request-redacted",
      participantIds: ["participant_later", "agent_zhuri"],
      visibility: "owner_only",
      consent: "decision_combination_freeze_r4",
      evidenceIds: ["evidence_calendar_provider_query"],
      updatedAt: "今天 11:26",
    },
  ],
  calendarEvents: [
    {
      id: "event_product_review",
      title: "Project Solution 组合评审",
      start: "09:30",
      end: "10:10",
      calendar: "个人日历",
      projectId: "project_chat_solution",
      readOnly: true,
    },
    {
      id: "event_ceramic_kiln",
      title: "取回第二批釉片",
      start: "18:30",
      end: "19:00",
      calendar: "生活",
      projectId: "project_ceramic_studio",
      readOnly: true,
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function replaceById(items, id, update) {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return { ...item, ...update(item) };
  });
  if (!found) throw new Error(`Unknown object: ${id}`);
  return next;
}

function requireRevision(object, expectedRevision) {
  if (object.revision !== expectedRevision) {
    throw new Error(`Stale revision: expected ${expectedRevision}, current ${object.revision}`);
  }
}

export function stableMockHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `sha256:mock-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createInitialState() {
  return clone(prototypeFixture);
}

export function findById(state, collection, id) {
  const object = state[collection]?.find((item) => item.id === id);
  if (!object) throw new Error(`Unknown ${collection}: ${id}`);
  return object;
}

export function getModeObjectIds(state, mode) {
  if (mode === "project") {
    return [
      ...state.projects.map((item) => item.id),
      ...state.works.map((item) => item.id),
      ...state.resources.map((item) => item.id),
    ];
  }
  if (mode === "today") {
    return [
      ...state.actions.filter((item) => item.scheduledFor === "today").map((item) => item.id),
      ...state.decisions.map((item) => item.id),
      ...state.runs.map((item) => item.id),
    ];
  }
  if (mode === "workbench") {
    return [
      ...state.decisions.map((item) => item.id),
      ...state.candidates.map((item) => item.id),
      ...state.runs.map((item) => item.id),
      ...state.evidence.map((item) => item.id),
    ];
  }
  throw new Error(`Unknown mode: ${mode}`);
}

export function completeAction(state, actionId) {
  const action = findById(state, "actions", actionId);
  if (!action.reversible) throw new Error("Only reversible Action can be completed here");
  if (action.status !== "open") throw new Error("Action is not open");

  return {
    state: {
      ...state,
      actions: replaceById(state.actions, actionId, () => ({ status: "completed" })),
    },
    mutation: {
      id: `mutation_complete_${actionId}`,
      kind: "action_complete",
      objectId: actionId,
      before: { status: action.status, dayPart: action.dayPart },
      undoable: true,
    },
  };
}

export function moveActionToDayPart(state, actionId, dayPart) {
  const action = findById(state, "actions", actionId);
  if (!action.reversible) throw new Error("Only reversible Action can move in Today");
  if (action.status !== "open") throw new Error("Completed Action cannot move");
  if (!['day', 'evening'].includes(dayPart)) throw new Error("Invalid day part");

  return {
    state: {
      ...state,
      actions: replaceById(state.actions, actionId, () => ({ dayPart })),
    },
    mutation: {
      id: `mutation_move_${actionId}_${dayPart}`,
      kind: "action_move",
      objectId: actionId,
      before: { status: action.status, dayPart: action.dayPart },
      undoable: true,
    },
  };
}

export function undoActionMutation(state, mutation) {
  if (!mutation?.undoable || !mutation.kind?.startsWith("action_")) {
    throw new Error("This mutation cannot be undone");
  }
  return {
    ...state,
    actions: replaceById(state.actions, mutation.objectId, () => ({
      status: mutation.before.status,
      dayPart: mutation.before.dayPart,
    })),
  };
}

export function reviseDecision(state, decisionId, content, expectedRevision) {
  const decision = findById(state, "decisions", decisionId);
  requireRevision(decision, expectedRevision);
  if (decision.status !== "candidate") throw new Error("Accepted Decision requires a new candidate");
  const revision = decision.revision + 1;
  return {
    ...state,
    decisions: replaceById(state.decisions, decisionId, () => ({
      content,
      revision,
      hash: stableMockHash(`${decisionId}|${revision}|${content}`),
    })),
  };
}

export function acceptDecision(state, decisionId, expectedRevision) {
  const decision = findById(state, "decisions", decisionId);
  requireRevision(decision, expectedRevision);
  if (decision.status !== "candidate") throw new Error("Decision is not awaiting acceptance");
  return {
    ...state,
    decisions: replaceById(state.decisions, decisionId, () => ({ status: "accepted" })),
  };
}

export function editCandidate(state, candidateId, content, expectedRevision) {
  const candidate = findById(state, "candidates", candidateId);
  requireRevision(candidate, expectedRevision);
  if (candidate.status !== "candidate") throw new Error("Candidate is already accepted");
  return {
    ...state,
    candidates: replaceById(state.candidates, candidateId, () => ({
      content,
      revision: candidate.revision + 1,
    })),
  };
}

export function acceptCandidate(state, candidateId, expectedRevision) {
  const candidate = findById(state, "candidates", candidateId);
  requireRevision(candidate, expectedRevision);
  if (candidate.status !== "candidate") throw new Error("Candidate is already accepted");
  return {
    ...state,
    candidates: replaceById(state.candidates, candidateId, () => ({ status: "accepted" })),
  };
}

export function startReconciliation(state, runId) {
  const run = findById(state, "runs", runId);
  if (run.status !== "outcome_unknown") throw new Error("Only outcome_unknown can reconcile");
  if (run.undoAllowed) throw new Error("External outcome_unknown must never expose Undo");
  return {
    ...state,
    runs: replaceById(state.runs, runId, () => ({ reconciliation: "querying" })),
  };
}

export function verifyReconciliation(state, runId) {
  const run = findById(state, "runs", runId);
  if (run.status !== "outcome_unknown" || run.reconciliation !== "querying") {
    throw new Error("Reconciliation query must run before verification");
  }
  return {
    ...state,
    runs: replaceById(state.runs, runId, () => ({
      status: "succeeded",
      reconciliation: "verified",
      updatedAt: "刚刚",
    })),
    evidence: replaceById(state.evidence, "evidence_calendar_provider_query", () => ({
      title: "Provider 查询确认事件已创建",
      observedAt: "刚刚",
      integrity: "verified",
    })),
  };
}

export function publishProjectUpdate(state, projectId, body, health) {
  const update = state.updates.find((item) => item.projectId === projectId);
  if (!update) throw new Error(`Unknown update for project: ${projectId}`);
  return {
    ...state,
    projects: replaceById(state.projects, projectId, () => ({ health })),
    updates: replaceById(state.updates, update.id, (current) => ({
      body,
      health,
      revision: current.revision + 1,
      publishedAt: "刚刚",
    })),
  };
}

export const fixtureContract = Object.freeze({
  modes: ["project", "today", "workbench"],
  sharedIds: [
    "project_chat_solution",
    "decision_combination_freeze_r4",
    "run_calendar_publish_attempt_02",
    "resource_reference_audits",
  ],
});

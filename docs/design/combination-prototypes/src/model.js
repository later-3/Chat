export const sourceCatalog = {
  basecamp: {
    id: "basecamp",
    label: "Basecamp",
    role: "Project room / collaboration",
    path: "/references/basecamp/",
  },
  linear: {
    id: "linear",
    label: "Linear",
    role: "Work / update",
    path: "/references/linear/",
  },
  things: {
    id: "things",
    label: "Things",
    role: "Today / Action",
    path: "/references/things/",
  },
  hey: {
    id: "hey",
    label: "HEY Calendar",
    role: "Calendar / Event",
    path: "/references/hey/",
  },
  "agent-feed": {
    id: "agent-feed",
    label: "Microsoft Agent Feed",
    role: "Agent supervision",
    path: "/references/agent-feed/",
  },
  heptabase: {
    id: "heptabase",
    label: "Heptabase",
    role: "Knowledge / evidence",
    path: "/references/heptabase/",
  },
};

export const sceneCatalog = {
  projects: {
    id: "projects",
    label: "Projects",
    shortLabel: "项目",
    capability: "project_portfolio",
    description: "多 Project 与入口",
  },
  room: {
    id: "room",
    label: "Project room",
    shortLabel: "房间",
    capability: "project_room",
    description: "讨论、资料、协作与持续上下文",
  },
  work: {
    id: "work",
    label: "Work",
    shortLabel: "工作",
    capability: "work_execution",
    description: "List / Peek / Detail 或 To-do 链",
  },
  updates: {
    id: "updates",
    label: "Updates",
    shortLabel: "进展",
    capability: "project_update",
    description: "负责人判断、健康与历史",
  },
  today: {
    id: "today",
    label: "Today",
    shortLabel: "今天",
    capability: "today_actions",
    description: "Action、This Evening、When 与完成",
  },
  calendar: {
    id: "calendar",
    label: "Calendar",
    shortLabel: "日历",
    capability: "calendar_events",
    description: "Day / Week / Year 与 Event 冲突",
  },
  agents: {
    id: "agents",
    label: "Agents",
    shortLabel: "代理",
    capability: "agent_supervision",
    description: "人工介入、决定与运行异常",
  },
  knowledge: {
    id: "knowledge",
    label: "Knowledge",
    shortLabel: "知识",
    capability: "knowledge_workbench",
    description: "Card、Whiteboard、context 与 provenance",
  },
};

export const themeCatalog = [
  {
    id: "source",
    label: "原型原貌",
    shortLabel: "原",
    description: "保留六套冻结参考原型各自的视觉语言",
  },
  {
    id: "warm-room",
    label: "Warm Room",
    shortLabel: "暖",
    description: "Basecamp 式温暖纸张与协作感",
  },
  {
    id: "quiet-day",
    label: "Quiet Day",
    shortLabel: "静",
    description: "Things 与 HEY 式安静、清晰的日常节奏",
  },
  {
    id: "graphite-ops",
    label: "Graphite Ops",
    shortLabel: "准",
    description: "Linear 与 Agent Feed 式精密执行感",
  },
  {
    id: "common-thread",
    label: "Common Thread",
    shortLabel: "合",
    description: "从六套参考中提炼的中性 Chat 共性",
  },
];

export const themeIds = themeCatalog.map((theme) => theme.id);

export function getTheme(id) {
  return themeCatalog.find((theme) => theme.id === id) || themeCatalog[0];
}

const sharedScenes = {
  updates: { source: "linear", route: "?view=project&project=atlas&tab=updates" },
  today: { source: "things", route: "#view=today" },
  calendar: { source: "hey", route: "?view=day&date=2026-08-09" },
  agents: { source: "agent-feed", route: "?tab=needs&mode=full" },
  knowledge: { source: "heptabase", route: "" },
};

export const compositions = [
  {
    id: "room-linear",
    rank: 1,
    name: "Room × Linear Work",
    shortName: "房间优先",
    summary: "Basecamp 保持项目地点；Linear 独占 Work 与 Update。",
    defaultScene: "projects",
    scenes: {
      projects: { source: "basecamp", route: "?view=home" },
      room: { source: "basecamp", route: "?view=project&project=enormicom" },
      work: { source: "linear", route: "?view=issues&issue=issue-342&peek=1" },
      ...sharedScenes,
    },
    ownership: {
      project_portfolio: "basecamp",
      project_room: "basecamp",
      work_execution: "linear",
      project_update: "linear",
      today_actions: "things",
      calendar_events: "hey",
      agent_supervision: "agent-feed",
      knowledge_workbench: "heptabase",
    },
    refuses: ["Basecamp Tasks 与 Linear Issues 同时可达", "Calendar 拥有 Work", "Feed 成为权威事实页"],
  },
  {
    id: "room-basecamp",
    rank: 2,
    name: "Basecamp Native × Linear Update",
    shortName: "原生房间",
    summary: "Basecamp 独占 Room 与 To-do；Linear 只补负责人 Update。",
    defaultScene: "projects",
    scenes: {
      projects: { source: "basecamp", route: "?view=home" },
      room: { source: "basecamp", route: "?view=project&project=enormicom" },
      work: { source: "basecamp", route: "?view=tool&project=enormicom&tool=todos" },
      ...sharedScenes,
    },
    ownership: {
      project_portfolio: "basecamp",
      project_room: "basecamp",
      work_execution: "basecamp",
      project_update: "linear",
      today_actions: "things",
      calendar_events: "hey",
      agent_supervision: "agent-feed",
      knowledge_workbench: "heptabase",
    },
    refuses: ["Linear Issues 与 Basecamp To-dos 同时可达", "Update 混进 Message Board", "Today 替代 Project"],
  },
  {
    id: "work-linear",
    rank: 3,
    name: "Linear Console × Basecamp Room",
    shortName: "工作优先",
    summary: "Linear 作为工作与状态主骨架；Basecamp 只补协作房间。",
    defaultScene: "work",
    scenes: {
      projects: { source: "linear", route: "?view=project&project=atlas&tab=overview" },
      room: { source: "basecamp", route: "?view=project&project=enormicom" },
      work: { source: "linear", route: "?view=issues&issue=issue-342&peek=1" },
      ...sharedScenes,
    },
    ownership: {
      project_portfolio: "linear",
      project_room: "basecamp",
      work_execution: "linear",
      project_update: "linear",
      today_actions: "things",
      calendar_events: "hey",
      agent_supervision: "agent-feed",
      knowledge_workbench: "heptabase",
    },
    refuses: ["Basecamp Home 成为第二个 Project index", "Basecamp Tasks 可达", "Project room 复制 Work list"],
  },
];

export const compositionIds = compositions.map((composition) => composition.id);

export function getComposition(id) {
  return compositions.find((composition) => composition.id === id) || compositions[0];
}

export function getInitialRoute(location = window.location) {
  const params = new URLSearchParams(location.search);
  const composition = getComposition(params.get("composition"));
  const requestedScene = params.get("scene");
  return {
    compositionId: composition.id,
    sceneId: composition.scenes[requestedScene] ? requestedScene : composition.defaultScene,
    themeId: getTheme(params.get("theme")).id,
  };
}

export function routeUrl({ compositionId, sceneId, themeId = "source" }, location = window.location) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("composition", getComposition(compositionId).id);
  url.searchParams.set("scene", sceneId);
  const theme = getTheme(themeId);
  if (theme.id !== "source") url.searchParams.set("theme", theme.id);
  return url;
}

export function referenceUrl(sourceId, compositionId, route = "", themeId = "source") {
  const source = sourceCatalog[sourceId];
  if (!source) throw new Error(`Unknown reference source: ${sourceId}`);
  const url = new URL(source.path, window.location.origin);
  const [query = "", hash = ""] = route.split("#");
  const initial = new URLSearchParams(query.replace(/^\?/, ""));
  initial.set("embedded", "1");
  initial.set("composition", compositionId);
  initial.set("theme", getTheme(themeId).id);
  url.search = initial.toString();
  if (hash) url.hash = hash;
  return url.toString();
}

export function assertNoDuplicateOwners(composition) {
  const required = Object.values(sceneCatalog).map((scene) => scene.capability);
  const assigned = Object.keys(composition.ownership);
  if (new Set(assigned).size !== assigned.length) throw new Error("Duplicate capability owner");
  for (const capability of required) {
    if (!composition.ownership[capability]) throw new Error(`Missing owner for ${capability}`);
  }
  return true;
}

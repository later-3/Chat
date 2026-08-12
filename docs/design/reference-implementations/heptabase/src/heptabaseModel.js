export const people = [
  { id: "later", name: "Later", role: "Space owner" },
  { id: "momo", name: "墨尺", role: "Can edit" },
  { id: "aju", name: "阿橘", role: "Can view" },
];

const cards = [
  {
    id: "card-context-package",
    title: "Project Context Package v4",
    type: "note",
    tone: "mint",
    tags: ["Project Solution", "Context"],
    summary: "本轮规划只采用已确认的 Project、Stage、Decision 与 Evidence 版本。",
    content:
      "Context Package 不是完整历史。它保存本轮采用、排除和裁剪的对象版本，并让规划结果可以解释。\n\n来源：Project ledger v5、Decision d_204、Evidence e_881。",
  },
  {
    id: "card-agent-boundary",
    title: "Agent 动态的责任边界",
    type: "note",
    tone: "coral",
    tags: ["Agent", "Decision"],
    summary: "动态是事实投影；候选、决定、运行异常与正式结果保持可辨。",
    content:
      "Feed 只负责把人带到正确对象。高影响决定绑定 revision 与 hash；outcome_unknown 只能对账，不能提供通用 Retry。",
  },
  {
    id: "card-memory-evidence",
    title: "Memory 参考证据",
    type: "source",
    tone: "blue",
    tags: ["Evidence", "Memory"],
    summary: "memmy 与 Tencent MemoryCore 的真实查询、导入和对账差异。",
    content:
      "同步 materialized 与异步 accepted 是不同完成语义。外部记忆只提供召回候选；Chat 保存采用证据和导入意图。",
  },
  {
    id: "card-shape-up",
    title: "Shape Up：投入与未知",
    type: "source",
    tone: "sand",
    tags: ["Method", "Scope"],
    summary: "Appetite、No-gos、Scope discovery 与 Circuit Breaker。",
    content:
      "采用固定投入、可变范围和未知收敛；拒绝把六周周期或无 Backlog 写死为所有项目规则。",
  },
  {
    id: "card-iteration-gate",
    title: "Iteration Gate · 决定与退出",
    type: "note",
    tone: "blue",
    tags: ["Iteration", "Decision"],
    summary: "本轮承诺、退出条件与需要人工确认的 Decision 保持显式。",
    content:
      "Iteration Gate 只引用已经确认的 Work、Scope 与 Evidence。它不会因为 Whiteboard 上的空间接近而自动建立领域关系。",
  },
  {
    id: "card-personal-studio",
    title: "周末陶艺：第一只可用茶杯",
    type: "note",
    tone: "lavender",
    tags: ["Personal", "Ceramics"],
    summary: "练习拉坯、修坯和透明釉，保留每次失败的照片与配方。",
    content:
      "目标不是做作品集，而是完成一只日常能用的茶杯。周六上午练习拉坯，周日晚记录泥料含水量和失败原因。",
  },
];

const boards = [
  {
    id: "board-project-research",
    title: "Project Solution · 研究地图",
    group: "Work",
    shared: true,
    sections: [
      { id: "section-facts", title: "权威事实与上下文", tone: "mint", x: 56, y: 84, width: 510, height: 330 },
      { id: "section-method", title: "方法输入，不是事实源", tone: "sand", x: 596, y: 84, width: 338, height: 330 },
      { id: "section-agents", title: "监督与决定", tone: "coral", x: 248, y: 454, width: 560, height: 260 },
    ],
    placements: [
      { id: "placement-context-research", cardId: "card-context-package", x: 82, y: 132, width: 214 },
      { id: "placement-memory-research", cardId: "card-memory-evidence", x: 320, y: 176, width: 214 },
      { id: "placement-shape-research", cardId: "card-shape-up", x: 624, y: 152, width: 250 },
      { id: "placement-agent-research", cardId: "card-agent-boundary", x: 392, y: 512, width: 254 },
    ],
    connections: [
      { id: "connection-memory-context", from: "placement-memory-research", to: "placement-context-research", label: "被选择后进入" },
      { id: "connection-shape-context", from: "placement-shape-research", to: "placement-context-research", label: "方法约束" },
      { id: "connection-agent-context", from: "placement-agent-research", to: "placement-context-research", label: "决定采用版本" },
    ],
  },
  {
    id: "board-ps2-planning",
    title: "PS2 · Shaping 与 Iteration",
    group: "Work",
    shared: true,
    sections: [
      { id: "section-input", title: "本轮输入", tone: "mint", x: 76, y: 106, width: 420, height: 540 },
      { id: "section-commitment", title: "候选承诺", tone: "blue", x: 536, y: 106, width: 400, height: 540 },
    ],
    placements: [
      { id: "placement-context-planning", cardId: "card-context-package", x: 112, y: 168, width: 248 },
      { id: "placement-shape-planning", cardId: "card-shape-up", x: 584, y: 168, width: 260 },
      { id: "placement-gate-planning", cardId: "card-iteration-gate", x: 584, y: 508, width: 260 },
    ],
    connections: [
      { id: "connection-plan", from: "placement-context-planning", to: "placement-shape-planning", label: "约束候选" },
    ],
  },
  {
    id: "board-personal-studio",
    title: "个人工作室 · 陶艺",
    group: "Life",
    shared: false,
    sections: [
      { id: "section-practice", title: "这周练习", tone: "lavender", x: 84, y: 92, width: 520, height: 360 },
    ],
    placements: [
      { id: "placement-personal-studio", cardId: "card-personal-studio", x: 142, y: 166, width: 280 },
    ],
    connections: [],
  },
];

export function createInitialState() {
  return {
    cards: structuredClone(cards),
    boards: structuredClone(boards),
    selectedBoardId: boards[0].id,
    selectedCardId: cards[0].id,
    panel: "card",
    history: [],
    nextId: 20,
    chat: {
      contexts: ["card-context-package", "card-memory-evidence"],
      spaceSearch: false,
      question: "",
      response: null,
      audit: [],
    },
    permissionsByBoardId: {
      "board-project-research": { later: "owner", momo: "edit", aju: "view" },
      "board-ps2-planning": { later: "owner", momo: "view", aju: "none" },
      "board-personal-studio": { later: "owner", momo: "none", aju: "none" },
    },
  };
}

export function getBoard(state, boardId = state.selectedBoardId) {
  return state.boards.find((board) => board.id === boardId) || state.boards[0];
}

export function getCard(state, cardId = state.selectedCardId) {
  return state.cards.find((card) => card.id === cardId) || state.cards[0];
}

export function placementsForCard(state, cardId) {
  return state.boards.flatMap((board) =>
    board.placements
      .filter((placement) => placement.cardId === cardId)
      .map((placement) => ({ boardId: board.id, boardTitle: board.title, ...placement })),
  );
}

export function updateCard(state, cardId, patch) {
  return {
    ...state,
    cards: state.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)),
  };
}

export function openLocation(state, boardId, placementId) {
  return {
    ...state,
    history: [...state.history, { boardId: state.selectedBoardId, cardId: state.selectedCardId }],
    selectedBoardId: boardId,
    selectedCardId: getBoard(state, boardId).placements.find((item) => item.id === placementId)?.cardId || state.selectedCardId,
    panel: "locations",
    focusedPlacementId: placementId,
  };
}

export function goBack(state) {
  const previous = state.history.at(-1);
  if (!previous) return state;
  return {
    ...state,
    history: state.history.slice(0, -1),
    selectedBoardId: previous.boardId,
    selectedCardId: previous.cardId,
    focusedPlacementId: null,
  };
}

export function placeCard(state, boardId, cardId) {
  const board = getBoard(state, boardId);
  const existing = board.placements.find((placement) => placement.cardId === cardId);
  if (existing) return { state, placementId: existing.id, created: false };
  const placementId = `placement-${state.nextId}`;
  return {
    created: true,
    placementId,
    state: {
      ...state,
      nextId: state.nextId + 1,
      boards: state.boards.map((item) =>
        item.id === boardId
          ? {
              ...item,
              placements: [
                ...item.placements,
                { id: placementId, cardId, x: 120 + (item.placements.length % 3) * 236, y: 530, width: 220 },
              ],
            }
          : item,
      ),
    },
  };
}

export function movePlacement(state, boardId, placementId, position) {
  return {
    ...state,
    boards: state.boards.map((board) =>
      board.id === boardId
        ? {
            ...board,
            placements: board.placements.map((placement) =>
              placement.id === placementId ? { ...placement, ...position } : placement,
            ),
          }
        : board,
    ),
  };
}

export function removePlacement(state, boardId, placementId) {
  return {
    ...state,
    boards: state.boards.map((board) =>
      board.id === boardId
        ? { ...board, placements: board.placements.filter((placement) => placement.id !== placementId) }
        : board,
    ),
  };
}

export function askWithContext(state, question) {
  const explicit = state.chat.contexts.map((cardId) => getCard(state, cardId).title);
  const audit = explicit.map((title) => `viewed ${title}`);
  if (state.chat.spaceSearch) audit.unshift("searched current Space");
  return {
    ...state,
    chat: {
      ...state.chat,
      question,
      audit,
      response: {
        status: "candidate",
        title: "可复用的 Project Context 原则",
        body: "同一个对象可以出现在多个工作表面，但权威内容只保存一次。空间位置帮助编排，不自动变成 Project 关系；采用前仍需明确来源与版本。",
        citations: explicit,
      },
    },
  };
}

export function saveResponseAsCard(state) {
  if (!state.chat.response) return state;
  const cardId = `card-ai-${state.nextId}`;
  return {
    ...state,
    nextId: state.nextId + 1,
    selectedCardId: cardId,
    panel: "card",
    cards: [
      ...state.cards,
      {
        id: cardId,
        title: state.chat.response.title,
        type: "candidate",
        tone: "mint",
        tags: ["AI candidate", "Provenance"],
        summary: state.chat.response.body,
        content: `${state.chat.response.body}\n\n生成来源：${state.chat.response.citations.join("、")}。`,
      },
    ],
    chat: { ...state.chat, response: null },
  };
}

export function setPermission(state, boardId, personId, permission) {
  if (personId === "later") return state;
  const boardPermissions = state.permissionsByBoardId[boardId] || {};
  return {
    ...state,
    permissionsByBoardId: {
      ...state.permissionsByBoardId,
      [boardId]: { ...boardPermissions, [personId]: permission },
    },
  };
}

export function visibleCardIdsFor(state, personId) {
  if (personId === "later") return state.cards.map((card) => card.id);
  return [
    ...new Set(
      state.boards
        .filter((board) => {
          const permission = state.permissionsByBoardId[board.id]?.[personId] || "none";
          return board.shared && permission !== "none";
        })
        .flatMap((board) => board.placements.map((placement) => placement.cardId)),
    ),
  ];
}

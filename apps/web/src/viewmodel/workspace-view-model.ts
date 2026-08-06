import type { ChatMessage } from "./chat-view-model.js";

export type SessionId = "okr" | "ppt" | "code" | "canvas";
export type WorkPanelId = "run" | "result" | "slides" | "notes" | "code" | "review" | "canvas";
export type StatusTone = "success" | "warning" | "danger" | "neutral";

export interface WorkTabFixture {
  id: WorkPanelId;
  label: string;
}

export interface SessionFixture {
  id: SessionId;
  spaceLabel: string;
  title: string;
  group: "需要处理" | "进行中" | "最近";
  status: string;
  tone: StatusTone;
  activity: string;
  currentWorkTitle: string;
  currentWorkSummary: string;
  initialWorkPanel: WorkPanelId;
  workTabs: readonly WorkTabFixture[];
  messages: readonly ChatMessage[];
}

export interface WorkflowNodeFixture {
  id: string;
  step: string;
  title: string;
  status: "已完成" | "失败" | "未开始";
  tone: StatusTone;
  duration: string;
  x: number;
  y: number;
  details: {
    purpose: string;
    source: string;
    result: string;
    next: string;
  };
}

export const SESSION_FIXTURES: readonly SessionFixture[] = [
  {
    id: "okr",
    spaceLabel: "OKR整理",
    title: "整理季度 OKR 进展",
    group: "需要处理",
    status: "失败 · 需要查看",
    tone: "danger",
    activity: "17.5 秒前更新",
    currentWorkTitle: "整理季度 OKR 进展",
    currentWorkSummary: "指标计算没有完成，已经取得的 7 条资料仍然保留。",
    initialWorkPanel: "run",
    workTabs: [
      { id: "run", label: "运行" },
      { id: "result", label: "结果" },
    ],
    messages: [
      {
        id: "okr-user-1",
        role: "user",
        text: "帮我整理一下这个季度 OKR 的进展，重点看 KR 完成度。",
      },
      {
        id: "okr-assistant-1",
        role: "assistant",
        text: "好的。我会先检索进展资料并计算指标。右侧工作窗口会持续显示运行情况，你也可以继续补充要求。",
      },
      {
        id: "okr-user-2",
        role: "user",
        text: "不用展开太多细节，失败原因放在最前面。",
        localOnly: true,
      },
    ],
  },
  {
    id: "ppt",
    spaceLabel: "周会PPT",
    title: "准备产品周会 PPT",
    group: "进行中",
    status: "正在生成第 4 页",
    tone: "warning",
    activity: "刚刚更新",
    currentWorkTitle: "生成产品周会 PPT",
    currentWorkSummary: "正在生成第 4 页，前三页预览已经可以查看。",
    initialWorkPanel: "slides",
    workTabs: [
      { id: "slides", label: "幻灯片" },
      { id: "run", label: "运行" },
      { id: "notes", label: "讲稿" },
    ],
    messages: [
      {
        id: "ppt-user-1",
        role: "user",
        text: "把本周产品进展整理成 6 页周会 PPT。",
      },
      {
        id: "ppt-assistant-1",
        role: "assistant",
        text: "已经建立 6 页结构。我会在右侧持续更新幻灯片，你可以边看边让我调整。",
      },
      {
        id: "ppt-user-2",
        role: "user",
        text: "首页不要口号，直接写本周结论。",
        localOnly: true,
      },
    ],
  },
  {
    id: "code",
    spaceLabel: "代码审查",
    title: "审查登录模块",
    group: "进行中",
    status: "发现 2 个问题",
    tone: "warning",
    activity: "2 分钟前更新",
    currentWorkTitle: "审查登录模块",
    currentWorkSummary: "已标出 2 个需要确认的问题，代码修改尚未提交。",
    initialWorkPanel: "code",
    workTabs: [
      { id: "code", label: "代码" },
      { id: "review", label: "审查结果" },
      { id: "run", label: "运行" },
    ],
    messages: [
      {
        id: "code-user-1",
        role: "user",
        text: "帮我审查登录模块，先找会导致会话失效的问题。",
      },
      {
        id: "code-assistant-1",
        role: "assistant",
        text: "我会先检查刷新令牌和重试路径。右侧代码窗口会保留定位结果。",
      },
    ],
  },
  {
    id: "canvas",
    spaceLabel: "产品方向",
    title: "梳理产品方向",
    group: "最近",
    status: "白板 · 今天更新",
    tone: "neutral",
    activity: "今天更新",
    currentWorkTitle: "产品方向白板",
    currentWorkSummary: "已整理 4 个主题，可以继续在对话中补充或调整。",
    initialWorkPanel: "canvas",
    workTabs: [
      { id: "canvas", label: "白板" },
      { id: "result", label: "摘要" },
    ],
    messages: [
      {
        id: "canvas-user-1",
        role: "user",
        text: "把我们关于 Chat 产品方向的想法整理到白板上。",
      },
      {
        id: "canvas-assistant-1",
        role: "assistant",
        text: "我已经按用户价值、产品边界、工作空间和长期能力分成四组。",
      },
    ],
  },
];

export const SESSION_BY_ID = Object.fromEntries(
  SESSION_FIXTURES.map((session) => [session.id, session]),
) as Record<SessionId, SessionFixture>;

export const WORKFLOW_NODES: readonly WorkflowNodeFixture[] = [
  {
    id: "receive",
    step: "步骤 1",
    title: "接收要求",
    status: "已完成",
    tone: "success",
    duration: "0.1 秒",
    x: 206,
    y: 16,
    details: {
      purpose: "确认用户本轮要整理的目标和展示重点。",
      source: "当前会话中用户已经提交的要求。",
      result: "已确认重点查看 KR 完成度。",
      next: "把目标拆成资料检索和指标计算步骤。",
    },
  },
  {
    id: "plan",
    step: "步骤 2",
    title: "拆解任务",
    status: "已完成",
    tone: "success",
    duration: "1.8 秒",
    x: 206,
    y: 126,
    details: {
      purpose: "把整理工作拆成可以独立检查的步骤。",
      source: "用户要求和季度 OKR 模板。",
      result: "形成资料检索、指标计算和汇总三个阶段。",
      next: "并行检索资料并计算指标。",
    },
  },
  {
    id: "research",
    step: "步骤 3A",
    title: "检索资料",
    status: "已完成",
    tone: "success",
    duration: "12.4 秒",
    x: 64,
    y: 272,
    details: {
      purpose: "找到本季度 KR 的最新进展和来源。",
      source: "本地示例中的周报与 OKR 资料。",
      result: "找到 7 条可以继续使用的资料。",
      next: "把资料交给汇总步骤。",
    },
  },
  {
    id: "metrics",
    step: "步骤 3B",
    title: "计算指标",
    status: "失败",
    tone: "danger",
    duration: "3.2 秒",
    x: 344,
    y: 272,
    details: {
      purpose: "计算每个 KR 的当前完成度，并标记与目标值的差距。",
      source: "Q3 OKR 指标表及其最新数据。",
      result: "数据服务暂时无法访问，尚未形成完成度结果。",
      next: "资料检索结果已经保留；恢复能力接入后，只需重新执行这一步。",
    },
  },
  {
    id: "summarize",
    step: "步骤 4",
    title: "汇总生成",
    status: "未开始",
    tone: "neutral",
    duration: "—",
    x: 206,
    y: 414,
    details: {
      purpose: "把资料和指标整理成用户可读的季度进展。",
      source: "资料检索与指标计算的可见结果。",
      result: "等待上一步恢复后开始。",
      next: "生成候选结果并等待正式保存。",
    },
  },
  {
    id: "commit",
    step: "步骤 5",
    title: "保存正式结果",
    status: "未开始",
    tone: "neutral",
    duration: "—",
    x: 206,
    y: 524,
    details: {
      purpose: "检查候选结果后，把它保存为用户以后可以恢复的正式内容。",
      source: "通过校验的候选结果。",
      result: "尚未开始，没有产生正式成功。",
      next: "等待汇总步骤完成。",
    },
  },
];

export const SESSION_GROUPS = ["需要处理", "进行中", "最近"] as const;

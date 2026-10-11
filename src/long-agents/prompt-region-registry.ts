/**
 * Prompt 区域注册表（唯一事实源，pi-004 P1-U2 / T1 目标）
 *
 * 一处定义，三处消费：
 *   1. 装配顶层段识别 —— pi-agent-session.ts 的 topLevelTags()（原 CHAT_TOP_LEVEL_TAGS 字面量）
 *   2. 捕获解析白名单 —— session-prompt-capture.ts 的 captureSectionTags()（原 CHAT_SECTION_TAGS 字面量）
 *   3. 展示/检查/概念空间当前事实 —— regionById / PROMPT_REGION_REGISTRY 直接引用
 *
 * 字段语义：
 *   - tag        XML 标签名；pi-base 无标记（空串）
 *   - kind       捕获解析用的 section kind（无白名单条目者为 null）
 *   - parent     真实嵌套父区域（audit §11 字节级结论：rcc⊂自定义指令、当前项目⊂协作上下文）
 *   - topLevel   是否参与装配“直排顶层段”识别（原 CHAT_TOP_LEVEL_TAGS 成员）
 *   - capture    捕获解析白名单是否识别（false = 已知缺口 D8：落 pi-base/相邻段）
 *   - documented 概念空间 prompt-region 清单是否登记（false = D8 缺口，待 P1-U2 同步）
 */

export interface PromptRegionDef {
  /** 区域 id（= XML 标签名；pi-base 为 "pi-base"） */
  readonly id: string;
  /** XML 标签；pi-base 无标记为空串 */
  readonly tag: string;
  /** 展示名 */
  readonly label: string;
  /** 捕获解析 kind（无白名单条目为 null） */
  readonly kind: "chat-project" | "chat-collaboration" | "chat-custom-instructions" | "chat-interaction-harness" | "chat-identity" | "chat-long-term-memory" | null;
  /** 真实嵌套父区域；null=顶层 */
  readonly parent: string | null;
  /** 参与装配直排顶层段识别（原 CHAT_TOP_LEVEL_TAGS） */
  readonly topLevel: boolean;
  /** 捕获白名单是否识别（false=D8 缺口） */
  readonly capture: boolean;
  /** 概念空间清单是否登记（false=D8 缺口，P1-U2 同步） */
  readonly documented: boolean;
}

/**
 * 9 个实测区域（样本 01a109db payload 解剖，prompt-tree-status-quo §2/§7）。
 * 顺序保持与原 CHAT_SECTION_TAGS 一致（正则交替匹配顺序无歧义，但锁定防漂移）。
 */
export const PROMPT_REGION_REGISTRY: readonly PromptRegionDef[] = [
  { id: "pi-base", tag: "", label: "Pi 系统基础与资源", kind: null, parent: null, topLevel: false, capture: false, documented: true },
  { id: "chat_current_project", tag: "chat_current_project", label: "当前项目指令", kind: "chat-project", parent: "chat_project_collaboration", topLevel: true, capture: true, documented: true },
  { id: "chat_project_collaboration", tag: "chat_project_collaboration", label: "协作上下文", kind: "chat-collaboration", parent: null, topLevel: true, capture: true, documented: true },
  { id: "chat_agent_custom_instructions", tag: "chat_agent_custom_instructions", label: "自定义指令（含规则）", kind: "chat-custom-instructions", parent: null, topLevel: false, capture: true, documented: true },
  { id: "chat_runtime_capability_contract", tag: "chat_runtime_capability_contract", label: "运行时能力契约", kind: null, parent: "chat_agent_custom_instructions", topLevel: false, capture: false, documented: false },
  { id: "chat_interaction_harness", tag: "chat_interaction_harness", label: "交互 harness（协作规范）", kind: "chat-interaction-harness", parent: null, topLevel: true, capture: true, documented: true },
  { id: "chat_identity", tag: "chat_identity", label: "身份与职责", kind: "chat-identity", parent: null, topLevel: true, capture: true, documented: true },
  { id: "chat_long_term_memory", tag: "chat_long_term_memory", label: "长期记忆（Agent Memory）", kind: "chat-long-term-memory", parent: null, topLevel: true, capture: true, documented: true },
  { id: "chat_context", tag: "chat_context", label: "工作区上下文文件", kind: null, parent: null, topLevel: false, capture: false, documented: false },
];

/** 装配顶层段识别用标签前缀（原 pi-agent-session.ts CHAT_TOP_LEVEL_TAGS 字面量）。 */
export function topLevelTags(): readonly string[] {
  return PROMPT_REGION_REGISTRY.filter((region) => region.topLevel && region.tag !== "").map((region) => `<${region.tag}`);
}

/** 捕获解析白名单（原 session-prompt-capture.ts CHAT_SECTION_TAGS 字面量；顺序与原版一致）。 */
export function captureSectionTags(): readonly { readonly kind: NonNullable<PromptRegionDef["kind"]>; readonly tag: string; readonly label: string }[] {
  return PROMPT_REGION_REGISTRY
    .filter((region) => region.capture && region.kind !== null)
    .map((region) => ({ kind: region.kind as NonNullable<PromptRegionDef["kind"]>, tag: region.tag, label: region.label }));
}

export function regionById(id: string): PromptRegionDef | undefined {
  return PROMPT_REGION_REGISTRY.find((region) => region.id === id);
}

/**
 * The DEFAULT purposes for session-memory entries. This is a taxonomy, NOT a closed whitelist: the
 * defaults cover most statements, and when none of them fits, the agent may name its own short label.
 * The domain validation and the agent-facing tool schema read the same defaults, so the model is never
 * steered at a value the backend would reject. Kept dependency-free so the Pi tool can import it
 * without pulling the persistence graph.
 */
export const SESSION_MEMORY_CORE_PURPOSES = ["background", "goal", "experience", "rule", "finding"] as const;
export const SESSION_MEMORY_CUSTOM_PURPOSES = ["hypothesis", "decision", "open-question"] as const;

export const SESSION_MEMORY_PURPOSES: readonly string[] = [
  ...SESSION_MEMORY_CORE_PURPOSES,
  ...SESSION_MEMORY_CUSTOM_PURPOSES,
];

/** Short, model-facing meaning of each purpose (used as the tool schema description). */
export const SESSION_MEMORY_PURPOSE_HINTS: Readonly<Record<string, string>> = {
  background: "稳定背景与事实，后续轮次会长期依赖",
  goal: "当前目标或用户期望",
  experience: "可复用的经验与教训",
  rule: "必须遵守的约束规则",
  finding: "本轮排查得到的事实结论",
  hypothesis: "尚未证实的假设",
  decision: "已做出的决定及其理由",
  "open-question": "仍待解决的问题",
};

/** A purpose is a grouping key, so a custom label only has to be a short, stable-looking tag. */
export const SESSION_MEMORY_PURPOSE_PATTERN = /^[\p{L}][\p{L}\p{N}_-]{0,39}$/u;

/** Custom labels are allowed, so the purpose type is an open string rather than a finite union. */
export type SessionMemoryPurpose = string;

export function isSessionMemoryPurpose(value: unknown): value is SessionMemoryPurpose {
  return typeof value === "string" && SESSION_MEMORY_PURPOSE_PATTERN.test(value);
}

export function formatSessionMemoryPurposes(): string {
  const defaults = SESSION_MEMORY_PURPOSES.map((purpose) => `${purpose}（${SESSION_MEMORY_PURPOSE_HINTS[purpose] ?? ""}）`).join("、");
  return `${defaults}；都不合适时可以自定义一个短标签`;
}

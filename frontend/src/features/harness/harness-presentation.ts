type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function displayText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function plannerPolicyLabel(value: unknown): string {
  switch (value) {
    case "disabled":
      return "不需要规划";
    case "enabled":
      return "允许按需规划";
    case "required":
      return "必须先规划";
    case "required_for_intent_set":
      return "必须形成组合计划";
    default:
      return displayText(value, "未声明");
  }
}

export interface CollaborationMethodPresentation {
  protocolName: string;
  selectionReason: string;
  revision: string;
  hasCompositionOverlay: boolean;
  compositionTitle: string;
  compositionReason: string;
  intentCount: number;
  basePlannerLabel: string;
  effectivePlannerLabel: string;
}

/**
 * Converts the protocol resolver's public StepInputProjection into user-facing
 * copy. The projection remains the source of truth: the UI never infers an
 * effective planner policy from the number of visible cards.
 */
export function collaborationMethodPresentation(
  input: JsonRecord,
  fallbackRevision: number | string = "",
): CollaborationMethodPresentation {
  const overlay = asRecord(input.composition_overlay);
  const basePolicy = asRecord(input.base_execution_policy);
  const effectivePolicy = asRecord(input.effective_execution_policy);
  const intentCount =
    typeof overlay.intent_count === "number" && Number.isFinite(overlay.intent_count)
      ? Math.max(0, Math.trunc(overlay.intent_count))
      : 0;
  const hasCompositionOverlay = overlay.kind === "intent_set" && intentCount > 1;

  return {
    protocolName: displayText(input.protocol_name, "正在识别"),
    selectionReason: displayText(
      input.selection_reason,
      "完成意图和项目识别后，系统会说明本轮采用哪套协作方法。",
    ),
    revision: displayText(input.protocol_revision, String(fallbackRevision)),
    hasCompositionOverlay,
    compositionTitle: "先形成组合计划",
    compositionReason: displayText(
      overlay.reason,
      "本轮包含多个目标，系统会先组织推进顺序，再逐项完成。",
    ),
    intentCount,
    basePlannerLabel: plannerPolicyLabel(basePolicy.planner),
    effectivePlannerLabel: plannerPolicyLabel(effectivePolicy.planner),
  };
}

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

export type HitlMode = "inherit" | "deny" | "require_human" | "conditional" | "auto_continue";

export interface DecisionPointDefinition {
  key: string;
  version: number;
  category: string;
  label: string;
  description: string;
  subject_kind: string;
  default_mode: HitlMode;
  allowed_human_actions: string[];
  definition_hash: string;
}

export interface HitlPolicyRule {
  decision_point_key: string;
  mode: HitlMode;
  condition: Record<string, unknown> | null;
  on_match: "deny" | "require_human" | null;
  constraints: Record<string, unknown>;
  reason: string;
}

export interface HitlPolicySet {
  id: string;
  authority: "product_default" | "system_safety" | "user_preference" | string;
  scope_kind: string;
  scope_ref_id: string;
  scope_ref_revision: string | null;
  owner_principal_id: string | null;
  row_version: number;
  active_revision: null | {
    id: string;
    revision: number;
    policy_hash: string;
    change_summary: string;
    activated_at: string | null;
    rules: HitlPolicyRule[];
  };
}

export interface HitlPreview {
  decision_point_key: string;
  applicability: string;
  floor_action: "deny" | "require_human" | "auto_continue";
  preference_action: "deny" | "require_human" | "auto_continue";
  final_action: "deny" | "require_human" | "auto_continue";
  result_status: "resolved" | "failed_closed";
  facts: Record<string, unknown>;
  matched_rules: Array<{
    authority: string;
    scope_kind: string;
    scope_ref_id: string;
    mode: HitlMode;
    resolved_action: string;
    complete: boolean;
    reason: string;
  }>;
  reason_codes: string[];
  resolver_version: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `请求失败：HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function loadHitlConfiguration(): Promise<{
  decisionPoints: DecisionPointDefinition[];
  policySets: HitlPolicySet[];
}> {
  const [definitions, policies] = await Promise.all([
    request<{ decision_points: DecisionPointDefinition[] }>("/api/hitl/decision-points"),
    request<{ policy_sets: HitlPolicySet[] }>("/api/hitl/policy-sets"),
  ]);
  return { decisionPoints: definitions.decision_points, policySets: policies.policy_sets };
}

export function activateHitlPolicy(command: {
  scope_kind: string;
  scope_ref_id: string;
  scope_ref_revision?: string | null;
  expected_active_revision_id: string | null;
  change_summary: string;
  rules: HitlPolicyRule[];
}): Promise<HitlPolicySet> {
  return request<HitlPolicySet>("/api/hitl/policy-sets/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function previewHitlPolicy(command: {
  decision_point_key: string;
  scopes: Array<{ kind: string; ref_id: string }>;
  facts: Record<string, unknown>;
}): Promise<HitlPreview> {
  return request<HitlPreview>("/api/hitl/policy-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

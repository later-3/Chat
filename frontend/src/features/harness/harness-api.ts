import { checkedJson } from "../../api-client.js";

const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

export type ProjectKind = "delivery" | "learning" | "research" | "personal";
export type ProjectStatus =
  | "proposed"
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "archived";
export type WorkKind = "task" | "milestone" | "learning_unit" | "research_question";

export interface HarnessProject {
  id: string;
  scope_id: string;
  kind: ProjectKind;
  title: string;
  goal: string;
  status: ProjectStatus;
  current_milestone_id: string | null;
  row_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface HarnessWorkItem {
  id: string;
  scope_id: string;
  project_id: string | null;
  parent_work_item_id: string | null;
  kind: WorkKind;
  title: string;
  objective: string;
  status: string;
  priority: string;
  current_plan_revision_id: string | null;
  completion_evidence: Array<Record<string, unknown>>;
  completion_waiver_reason: string | null;
  row_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface HarnessActionItem {
  id: string;
  project_id: string | null;
  work_item_id: string | null;
  plan_node_id: string | null;
  title: string;
  assignee_kind: string;
  status: string;
  due_at: string | null;
  evidence: Array<Record<string, unknown>>;
  row_version: number;
}

export interface HarnessNote {
  id: string;
  kind: string;
  title: string;
  status: string;
  row_version: number;
  current_revision: null | {
    id: string;
    revision: number;
    content: string;
    content_hash: string;
    source_refs: Array<Record<string, unknown>>;
    created_at: string;
  };
  created_at: string;
  updated_at: string;
}

export interface HarnessMemory {
  id: string;
  scope_kind: string;
  scope_ref_id: string | null;
  memory_kind: string;
  status: string;
  row_version: number;
  current_revision: null | {
    id: string;
    revision: number;
    content: string;
    content_hash: string;
    source_refs: Array<Record<string, unknown>>;
    created_at: string;
  };
}

export interface HarnessMemoryCandidate {
  id: string;
  scope_kind: string;
  scope_ref_id: string | null;
  memory_kind: string;
  content: string;
  status: string;
  source_refs: Array<Record<string, unknown>>;
  created_at: string;
}

export interface ContextPackage {
  id: string;
  session_id: string;
  run_id: string;
  stage: "directory" | "detail";
  revision: number;
  previous_package_id: string | null;
  selected_project_id: string | null;
  selected_work_item_id: string | null;
  token_budget: number;
  estimated_tokens: number;
  package_hash: string;
  status: string;
  revision_reason: string;
  created_by: string;
  created_at: string;
  items: Array<{
    source_kind: string;
    source_id: string;
    source_revision: string | null;
    title: string;
    content: string;
    adopted: boolean;
    locked: boolean;
    selection_origin: "system" | "human";
    reason: string;
    token_estimate: number;
  }>;
}

export interface CollaborationIntentSet {
  id: string;
  session_id: string;
  interaction_id: string;
  run_id: string;
  status: "candidate" | "accepted" | "superseded";
  row_version: number;
  accepted_revision_id: string | null;
  current_revision: {
    id: string;
    revision: number;
    execution_order: string[];
    combination_policy: "single" | "sequential" | "parallel_safe";
    source_prompt_hash: string;
    revision_hash: string;
    author_kind: string;
    status: string;
    created_at: string;
  };
  intents: Array<{
    id: string;
    branch_key: string;
    ordinal: number;
    status: string;
    row_version: number;
    current_revision: {
      id: string;
      revision: number;
      scenario: string;
      query_kind: string | null;
      goal: string;
      expected_outcome: string;
      confidence: number;
      project_hint: string | null;
      selected_project_id: string | null;
      needs_plan: boolean;
      needs_clarification: boolean;
      clarification_question: string | null;
      context_keywords: string[];
      dependency_branch_keys: string[];
      constraints: string[];
      reason_summary: string;
      source_model_call_revision_id: string | null;
      author_kind: string;
      status: string;
      revision_hash: string;
      created_at: string;
    };
    clarification: null | {
      id: string;
      question: string;
      status: string;
      current_answer_id: string | null;
      row_version: number;
    };
  }>;
  created_at: string;
  updated_at: string;
}

export interface ProjectContext {
  project: HarnessProject;
  work_items: HarnessWorkItem[];
  action_items: HarnessActionItem[];
  notes: HarnessNote[];
  accepted_memory: HarnessMemory[];
  work_details: Array<{
    work_item: HarnessWorkItem;
    plan: null | {
      id: string;
      status: string;
      row_version: number;
      revision: null | {
        id: string;
        revision: number;
        summary: string;
        status: string;
        nodes: Array<Record<string, unknown>>;
      };
    };
    action_items: HarnessActionItem[];
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return checkedJson<T>(await fetch(`${API_BASE_URL}${path}`, init), "Product Harness请求失败");
}

function commandId(kind: string): string {
  return `web:${kind}:${crypto.randomUUID()}`;
}

export async function listProjects(): Promise<HarnessProject[]> {
  return (await request<{ projects: HarnessProject[] }>("/api/harness/projects")).projects;
}

export function createProject(input: {
  kind: ProjectKind;
  title: string;
  goal: string;
  status: "proposed" | "active";
  session_id?: string | null;
}): Promise<HarnessProject> {
  return request("/api/harness/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command_id: commandId("create-project"), ...input }),
  });
}

export function getProjectContext(projectId: string): Promise<ProjectContext> {
  return request(`/api/harness/projects/${projectId}`);
}

export async function listWorkItems(projectId?: string | null): Promise<HarnessWorkItem[]> {
  const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return (await request<{ work_items: HarnessWorkItem[] }>(`/api/harness/work-items${suffix}`))
    .work_items;
}

export function createWorkItem(input: {
  project_id: string | null;
  kind: WorkKind;
  title: string;
  objective: string;
  priority: string;
  status: "draft" | "planned" | "ready";
}): Promise<HarnessWorkItem> {
  return request("/api/harness/work-items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command_id: commandId("create-work"), ...input }),
  });
}

export async function listNotes(projectId?: string | null): Promise<HarnessNote[]> {
  const suffix = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return (await request<{ notes: HarnessNote[] }>(`/api/harness/notes${suffix}`)).notes;
}

export function captureNote(input: {
  kind: string;
  title: string;
  content: string;
  project_id?: string | null;
}): Promise<HarnessNote> {
  return request("/api/harness/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("capture-note"),
      kind: input.kind,
      title: input.title,
      content: input.content,
      status: "active",
      links: input.project_id
        ? [{ resource_kind: "project", resource_id: input.project_id, relation: "documents" }]
        : [],
    }),
  });
}

export async function listMemory(): Promise<{
  accepted: HarnessMemory[];
  candidates: HarnessMemoryCandidate[];
}> {
  return request("/api/harness/memory");
}

export function proposeMemory(input: {
  scope_kind: string;
  scope_ref_id: string | null;
  memory_kind: string;
  content: string;
}): Promise<HarnessMemoryCandidate> {
  return request("/api/harness/memory-candidates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("propose-memory"),
      source_refs: [],
      ...input,
    }),
  });
}

export function resolveMemoryCandidate(
  candidateId: string,
  decision: "accept" | "reject" | "session_only",
): Promise<{ candidate_id: string; status: string; memory: HarnessMemory | null }> {
  return request(`/api/harness/memory-candidates/${candidateId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId(`memory-${decision}`),
      decision,
      decision_record_id: null,
    }),
  });
}

export async function latestContextPackage(sessionId: string): Promise<ContextPackage | null> {
  return (
    await request<{ context_package: ContextPackage | null }>(
      `/api/harness/sessions/${encodeURIComponent(sessionId)}/context/latest`,
    )
  ).context_package;
}

export function listIntentSets(sessionId: string): Promise<CollaborationIntentSet[]> {
  return request(`/api/harness/intents?session_id=${encodeURIComponent(sessionId)}&limit=20`);
}

export function reviseContextPackage(
  packageId: string,
  input: {
    expected_package_hash: string;
    reason: string;
    item_changes: Array<{
      ordinal: number;
      adopted?: boolean;
      locked?: boolean;
      content?: string;
      reason?: string;
    }>;
    added_source_refs: Array<{
      source_kind: string;
      source_id: string;
      adopted?: boolean;
      locked?: boolean;
      reason?: string;
    }>;
    token_budget?: number;
  },
): Promise<
  ContextPackage & {
    previous_package_hash: string;
    execution_invalidation: {
      invalidated: boolean;
      draft_ids: string[];
      decision_request_ids: string[];
      requires_recompile: boolean;
    };
  }
> {
  return request(`/api/harness/context-packages/${encodeURIComponent(packageId)}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("revise-context"),
      ...input,
    }),
  });
}

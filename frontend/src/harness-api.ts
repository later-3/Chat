const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL ?? "http://127.0.0.1:8030";

export type ProjectKind = "delivery" | "learning" | "research" | "personal";
export type ProjectStatus = "proposed" | "active" | "paused" | "completed" | "cancelled" | "archived";
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
  selected_project_id: string | null;
  selected_work_item_id: string | null;
  token_budget: number;
  estimated_tokens: number;
  package_hash: string;
  status: string;
  created_at: string;
  items: Array<{
    source_kind: string;
    source_id: string;
    source_revision: string | null;
    title: string;
    content: string;
    adopted: boolean;
    reason: string;
    token_estimate: number;
  }>;
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
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Product Harness请求失败：HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
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
  return (await request<{ work_items: HarnessWorkItem[] }>(`/api/harness/work-items${suffix}`)).work_items;
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
  return (await request<{ context_package: ContextPackage | null }>(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/context/latest`,
  )).context_package;
}

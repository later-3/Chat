import { apiErrorFromResponse, checkedJson } from "../../api-client.js";
import { authenticatedFetch } from "../../authentication-recovery.js";
import { API_BASE_URL } from "../../runtime-config.js";

export type ProjectionBlockState =
  | "available"
  | "partial"
  | "empty"
  | "unknown"
  | "forbidden"
  | "error";
export type WorkspaceDomain = "all" | "work" | "learning" | "research" | "life";
export type AssigneeKind = "user" | "agent" | "external";

export interface ProjectionSourceRevision {
  owner: string;
  resource_kind: string;
  resource_id: string;
  revision: string;
  updated_at: string | null;
}

export interface ProjectionSection {
  state: ProjectionBlockState;
  reason_code: string | null;
  detail: string | null;
  source_owner: string | null;
}

export interface ProjectionEnvelope<TData> {
  schema_version: string;
  view_schema: string;
  view_type: string;
  subject: Record<string, unknown>;
  projection_revision: string;
  generated_at: string;
  source_snapshot_at: string | null;
  freshness: {
    status: "fresh" | "stale" | "unknown";
    as_of: string;
    source_updated_at: string | null;
    consistency: string;
    reason_code: string | null;
  };
  source_revisions: ProjectionSourceRevision[];
  sections: Record<string, ProjectionSection>;
  permissions: {
    authorization_mode: string;
    audience: string;
    principal_id: string;
    allowed: string[];
    denied: Array<{ capability: string; reason_code: string }>;
  };
  data: TData;
}

export interface ResponsibilityItem {
  source_kind: "action_item" | "plan_node";
  source_id: string;
  work_item_id: string | null;
  work_title: string | null;
  title: string;
  objective: string;
  status: string;
  assignee_kind: AssigneeKind;
  due_at: string | null;
  evidence_count: number;
  commitment_state: "committed_action" | "accepted_plan_step";
}

export interface ResponsibilityLane {
  assignee_kind: AssigneeKind;
  label: string;
  description: string;
  items: ResponsibilityItem[];
}

export interface ProjectCardProjection {
  id: string;
  title: string;
  goal: string;
  kind: "delivery" | "learning" | "research" | "personal";
  domain: Exclude<WorkspaceDomain, "all">;
  status: string;
  row_version: number;
  updated_at: string;
  counts: {
    work_total: number;
    open_work: number;
    completed_work: number;
    blocked: number;
    open_actions: number;
    notes: number;
    accepted_memory: number;
    evidence_references: number;
  };
  count_progress: {
    completed: number;
    total: number;
    ratio: number | null;
    semantics: string;
  };
  responsibility_counts: Record<AssigneeKind, number>;
  next_actions: ResponsibilityItem[];
  attention: Array<{
    kind: string;
    severity: string;
    project_id: string;
    resource_id: string;
    title: string;
    reason_code: string;
  }>;
}

export interface WorkspaceProjectionData {
  domain: WorkspaceDomain;
  domains: Array<{
    id: Exclude<WorkspaceDomain, "all">;
    label: string;
    project_count: number;
  }>;
  summary: {
    project_count: number;
    open_work_count: number;
    blocked_count: number;
    open_action_count: number;
    attention_count: number;
    count_semantics: string;
  };
  projects: ProjectCardProjection[];
  independent_work: Array<Record<string, unknown>>;
  learning_queue: Array<{
    project_id: string;
    title: string;
    goal: string;
    status: string;
    unit_counts: ProjectCardProjection["count_progress"];
    next_actions: ResponsibilityItem[];
    next_review: { state: "unknown"; reason_code: string; value: null };
  }>;
  attention: ProjectCardProjection["attention"];
  limits: {
    projects: number;
    independent_items: number;
    projects_truncated: boolean;
    independent_items_truncated: boolean;
  };
}

export interface ProjectDossierData {
  project: {
    id: string;
    kind: ProjectCardProjection["kind"];
    title: string;
    goal: string;
    status: string;
    current_milestone_id: string | null;
    row_version: number;
    created_by: string;
    created_at: string;
    updated_at: string;
  };
  domain: Exclude<WorkspaceDomain, "all">;
  current_milestone: null | Record<string, unknown>;
  counts: ProjectCardProjection["counts"];
  count_progress: ProjectCardProjection["count_progress"];
  next_actions: ResponsibilityItem[];
  attention: ProjectCardProjection["attention"];
  role_lanes: ResponsibilityLane[];
  work_items: Array<{
    work_item: {
      id: string;
      title: string;
      objective: string;
      kind: string;
      status: string;
      priority: string;
      row_version: number;
      completion_evidence: Array<Record<string, unknown>>;
    };
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
  }>;
  knowledge: {
    notes: Array<Record<string, unknown>>;
    accepted_memory: Array<Record<string, unknown>>;
  };
  protocol: null | Record<string, unknown>;
  repositories: Array<Record<string, unknown>>;
  evidence: {
    references: Array<Record<string, unknown>>;
    reference_count: number;
    coverage: "partial";
  };
  activity: Array<Record<string, unknown>>;
}

export interface ObsidianProjectionFile {
  path: string;
  media_type: string;
  sha256: string;
  size_bytes: number;
  content: string;
}

export interface ObsidianProjectTree {
  schema_version: string;
  adapter: string;
  read_only: true;
  project_id: string;
  projection_revision: string;
  source_snapshot_at: string | null;
  root_directory: string;
  tree_hash: string;
  archive_name: string;
  file_count: number;
  total_bytes: number;
  files: ObsidianProjectionFile[];
}

async function projectionRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  return checkedJson<T>(
    await authenticatedFetch(`${API_BASE_URL}${path}`, { signal }),
    "读取工作台投影失败",
  );
}

export function getWorkspaceProjection(
  domain: WorkspaceDomain = "all",
  signal?: AbortSignal,
): Promise<ProjectionEnvelope<WorkspaceProjectionData>> {
  return projectionRequest(
    `/api/projections/workspace?domain=${encodeURIComponent(domain)}`,
    signal,
  );
}

export function getProjectDossier(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectionEnvelope<ProjectDossierData>> {
  return projectionRequest(
    `/api/projections/projects/${encodeURIComponent(projectId)}/dossier`,
    signal,
  );
}

export function getObsidianProjectTree(
  projectId: string,
  signal?: AbortSignal,
): Promise<ObsidianProjectTree> {
  return projectionRequest(
    `/api/projections/projects/${encodeURIComponent(projectId)}/obsidian/tree`,
    signal,
  );
}

export async function getObsidianProjectArchive(projectId: string): Promise<{
  blob: Blob;
  filename: string;
  projectionRevision: string | null;
  treeHash: string | null;
}> {
  const response = await authenticatedFetch(
    `${API_BASE_URL}/api/projections/projects/${encodeURIComponent(projectId)}/obsidian.zip`,
  );
  if (!response.ok) throw await apiErrorFromResponse(response, "生成Obsidian快照失败");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `chat-project-${projectId}.zip`;
  return {
    blob: await response.blob(),
    filename,
    projectionRevision: response.headers.get("x-projection-revision"),
    treeHash: response.headers.get("x-obsidian-tree-hash"),
  };
}

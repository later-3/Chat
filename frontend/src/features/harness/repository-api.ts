import { checkedJson } from "../../api-client.js";
import { authenticatedFetch } from "../../authentication-recovery.js";
import { createClientId } from "../../client-id.js";
import { API_BASE_URL } from "../../runtime-config.js";

export interface WorkspaceRootView {
  root_key: string;
  label: string;
  available: boolean;
  source: "configured" | "pi_compatibility" | string;
  error_code: string | null;
}

export interface RepositoryDirectory {
  name: string;
  relative_path: string;
  has_git_marker: boolean;
  selectable: boolean;
}

export interface RepositoryDirectoryPage {
  root_key: string;
  relative_path: string;
  parent_relative_path: string | null;
  current_has_git_marker: boolean;
  directories: RepositoryDirectory[];
  next_cursor: string | null;
}

export type RepositoryBindingRole = "primary" | "supporting" | "documentation";
export type RepositoryBindingStatus = "active" | "unavailable" | "detached";

export interface RepositoryBinding {
  id: string;
  scope_id: string;
  project_id: string;
  alias: string;
  display_name: string;
  role: RepositoryBindingRole;
  root_key: string;
  root_label: string;
  relative_path: string;
  generation: number;
  status: RepositoryBindingStatus;
  status_reason_code: string | null;
  latest_snapshot_sequence: number;
  row_version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
}

export interface RepositoryChangeSummary {
  path: string;
  status: string;
  kind: string;
}

export interface RepositoryGovernanceDocument {
  path: string;
  kind: string;
  sha256: string;
  size_bytes: number;
}

export interface RepositorySnapshot {
  id: string;
  binding_id: string;
  binding_generation: number;
  sequence: number;
  capture_status: "available" | "unavailable";
  observed_at: string;
  relative_path: string;
  head_oid: string | null;
  head_ref: string | null;
  upstream_ref: string | null;
  detached_head: boolean;
  ahead_count: number;
  behind_count: number;
  dirty: boolean;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  change_count: number;
  changes_truncated: boolean;
  change_summary: RepositoryChangeSummary[];
  fingerprint_complete: boolean;
  worktree_fingerprint: string | null;
  governance_manifest: RepositoryGovernanceDocument[];
  governance_manifest_hash: string;
  semantic_hash: string | null;
  error_code: string | null;
  error_detail_safe: string | null;
  inspector_version: string;
}

export interface RepositorySummary {
  binding: RepositoryBinding;
  latest_snapshot: RepositorySnapshot | null;
  last_available_snapshot: RepositorySnapshot | null;
}

export interface RepositoryCommandResult {
  binding: RepositoryBinding;
  snapshot: RepositorySnapshot | null;
  project_row_version?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return checkedJson<T>(
    await authenticatedFetch(`${API_BASE_URL}${path}`, init),
    "Project Repository请求失败",
  );
}

function commandId(kind: string): string {
  return `web:${kind}:${createClientId()}`;
}

export async function listWorkspaceRoots(): Promise<WorkspaceRootView[]> {
  return (await request<{ roots: WorkspaceRootView[] }>("/api/harness/repository-roots")).roots;
}

export function listRepositoryDirectories(input: {
  rootKey: string;
  relativePath: string;
  cursor?: string | null;
  limit?: number;
}): Promise<RepositoryDirectoryPage> {
  const query = new URLSearchParams({
    relative_path: input.relativePath,
    limit: String(input.limit ?? 50),
  });
  if (input.cursor) query.set("cursor", input.cursor);
  return request(
    `/api/harness/repository-roots/${encodeURIComponent(input.rootKey)}/directories?${query}`,
  );
}

export async function listProjectRepositories(projectId: string): Promise<RepositorySummary[]> {
  return (
    await request<{ repositories: RepositorySummary[] }>(
      `/api/harness/projects/${encodeURIComponent(projectId)}/repositories`,
    )
  ).repositories;
}

export function bindProjectRepository(input: {
  projectId: string;
  expectedProjectRowVersion: number;
  alias: string;
  displayName: string;
  role: RepositoryBindingRole;
  rootKey: string;
  relativePath: string;
}): Promise<RepositoryCommandResult> {
  return request(`/api/harness/projects/${encodeURIComponent(input.projectId)}/repositories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("repository-bind"),
      expected_project_row_version: input.expectedProjectRowVersion,
      alias: input.alias,
      display_name: input.displayName,
      role: input.role,
      root_key: input.rootKey,
      relative_path: input.relativePath,
    }),
  });
}

export function refreshProjectRepository(input: {
  bindingId: string;
  expectedBindingRowVersion: number;
}): Promise<RepositoryCommandResult> {
  return request(`/api/harness/repositories/${encodeURIComponent(input.bindingId)}/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("repository-refresh"),
      expected_binding_row_version: input.expectedBindingRowVersion,
    }),
  });
}

export function rebindProjectRepository(input: {
  bindingId: string;
  expectedProjectRowVersion: number;
  expectedBindingRowVersion: number;
  displayName: string;
  role: RepositoryBindingRole;
  rootKey: string;
  relativePath: string;
}): Promise<RepositoryCommandResult> {
  return request(`/api/harness/repositories/${encodeURIComponent(input.bindingId)}/rebind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("repository-rebind"),
      expected_project_row_version: input.expectedProjectRowVersion,
      expected_binding_row_version: input.expectedBindingRowVersion,
      display_name: input.displayName,
      role: input.role,
      root_key: input.rootKey,
      relative_path: input.relativePath,
    }),
  });
}

export function detachProjectRepository(input: {
  bindingId: string;
  expectedProjectRowVersion: number;
  expectedBindingRowVersion: number;
}): Promise<RepositoryCommandResult> {
  return request(`/api/harness/repositories/${encodeURIComponent(input.bindingId)}/detach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId("repository-detach"),
      expected_project_row_version: input.expectedProjectRowVersion,
      expected_binding_row_version: input.expectedBindingRowVersion,
    }),
  });
}

export function listRepositorySnapshots(input: {
  bindingId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<{ snapshots: RepositorySnapshot[]; next_cursor: string | null }> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
  if (input.cursor) query.set("cursor", input.cursor);
  return request(
    `/api/harness/repositories/${encodeURIComponent(input.bindingId)}/snapshots?${query}`,
  );
}

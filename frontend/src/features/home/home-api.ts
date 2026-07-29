import { checkedJson } from "../../api-client.js";
import { API_BASE_URL } from "../../runtime-config.js";

export interface HomeTodaySummary {
  open_work_count: number;
  collaboration_count: number;
  new_idea_count: number;
  pending_decision_count: number;
  active_run_count: number;
}

export interface HomeContinueItem {
  resource_kind: "project" | "work_item";
  id: string;
  title: string;
  objective: string;
  status: string;
  priority: string | null;
  project_id: string | null;
  project_title: string | null;
  updated_at: string;
}

export interface HomeCalendarDay {
  date: string;
  level: 0 | 1 | 2 | 3;
  interaction_count: number;
  work_change_count: number;
  knowledge_change_count: number;
  idea_count: number;
  artifact_count: number;
  source_count: number;
  source_refs: Array<{ kind: string; id: string; session_id?: string }>;
  summary: string;
}

export interface HomeArtifact {
  id: string;
  kind: string;
  title: string;
  media_type: string;
  status: string;
  updated_at: string;
}

export interface HomeIdea {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

export interface HomeOverview {
  as_of: string;
  year: number;
  utc_offset_minutes: number;
  today: string;
  today_summary: HomeTodaySummary;
  continue_items: HomeContinueItem[];
  calendar_days: HomeCalendarDay[];
  recent_artifacts: HomeArtifact[];
  ideas: HomeIdea[];
}

export interface HomeSearchResult {
  kind: "project" | "work_item" | "note";
  id: string;
  title: string;
  summary: string;
  status: string;
  revision: number;
}

export async function getHomeOverview(
  year: number,
  utcOffsetMinutes: number,
  signal?: AbortSignal,
): Promise<HomeOverview> {
  const query = new URLSearchParams({
    year: String(year),
    utc_offset_minutes: String(utcOffsetMinutes),
  });
  return checkedJson<HomeOverview>(
    await fetch(`${API_BASE_URL}/api/home/overview?${query.toString()}`, { signal }),
    "加载主页失败",
  );
}

export async function searchHomeResources(
  query: string,
  signal?: AbortSignal,
): Promise<HomeSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: "8" });
  const response = await checkedJson<{ resources: HomeSearchResult[] }>(
    await fetch(`${API_BASE_URL}/api/harness/search?${params.toString()}`, { signal }),
    "搜索项目、事项和知识失败",
  );
  return response.resources;
}

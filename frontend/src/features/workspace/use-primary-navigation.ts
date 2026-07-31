import { useEffect, useState } from "react";

import type { PrimaryView } from "../home/activity-rail";

const PRIMARY_VIEW_KEY = "chat.primary-view.v1";
const WORKSPACE_PROJECT_KEY = "chat.workspace-project.v1";

/**
 * Owns browser-only navigation projection. None of these values are product
 * facts: a reload may restore convenience state, while Product Store remains
 * authoritative for Projects and their selected revisions.
 */
export function usePrimaryNavigation() {
  const [primaryView, setPrimaryView] = useState<PrimaryView>(() => {
    const stored = window.sessionStorage.getItem(PRIMARY_VIEW_KEY);
    return stored === "chat" || stored === "workspace" ? stored : "home";
  });
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string | null>(() =>
    window.sessionStorage.getItem(WORKSPACE_PROJECT_KEY),
  );
  const [homeSearchQuery, setHomeSearchQuery] = useState("");

  useEffect(() => {
    window.sessionStorage.setItem(PRIMARY_VIEW_KEY, primaryView);
  }, [primaryView]);

  useEffect(() => {
    if (workspaceProjectId) {
      window.sessionStorage.setItem(WORKSPACE_PROJECT_KEY, workspaceProjectId);
    } else {
      window.sessionStorage.removeItem(WORKSPACE_PROJECT_KEY);
    }
  }, [workspaceProjectId]);

  useEffect(() => {
    const openWorkspaceSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setPrimaryView("workspace");
      window.requestAnimationFrame(() => document.getElementById("home-global-search")?.focus());
    };
    window.addEventListener("keydown", openWorkspaceSearch);
    return () => window.removeEventListener("keydown", openWorkspaceSearch);
  }, []);

  return {
    homeSearchQuery,
    primaryView,
    setHomeSearchQuery,
    setPrimaryView,
    setWorkspaceProjectId,
    workspaceProjectId,
  };
}

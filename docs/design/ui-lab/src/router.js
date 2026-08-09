const SCENES = new Set(["project", "today"]);
const THEMES = new Set(["thread", "paper", "graphite"]);
const PROJECT_STATES = new Set(["overview", "work", "work-detail", "artifacts"]);
const TODAY_STATES = new Set(["default", "evening-moved"]);

export function readRoute() {
  const params = new URLSearchParams(location.search);
  const scene = SCENES.has(params.get("scene")) ? params.get("scene") : "project";
  const preferredTheme = localStorage.getItem("chat-ui-lab-theme") || "thread";
  const themeCandidate = params.get("theme") || preferredTheme;
  const theme = THEMES.has(themeCandidate) ? themeCandidate : "thread";
  const allowedStates = scene === "project" ? PROJECT_STATES : TODAY_STATES;
  const fallbackState = scene === "project" ? "overview" : "default";
  const stateCandidate = params.get("state") || fallbackState;
  const state = allowedStates.has(stateCandidate) ? stateCandidate : fallbackState;

  return { scene, theme, state };
}

export function routeUrl(next) {
  const current = readRoute();
  const route = { ...current, ...next };
  const params = new URLSearchParams({
    scene: route.scene,
    theme: route.theme,
    state: route.state,
  });
  return `${location.pathname}?${params.toString()}`;
}

export function navigate(next, { replace = false } = {}) {
  const url = routeUrl(next);
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  window.dispatchEvent(new CustomEvent("ui-lab-route"));
}

export function normalizeRoute() {
  const route = readRoute();
  history.replaceState({}, "", routeUrl(route));
  return route;
}

const LOOPBACK_FALLBACK = "http://127.0.0.1:8030";

function trimTrailingSlash(value: string): string {
  if (value === "/") return "";
  return value.replace(/\/+$/, "");
}

/**
 * Resolve the public API origin once for every frontend feature.
 *
 * Browser builds default to the page origin so an IP address, domain or
 * reverse-proxy prefix can serve the complete product without rebuilding
 * hard-coded localhost URLs. The loopback fallback exists only for Node-based
 * contract tests where `window` is intentionally unavailable.
 */
export function resolveRuntimeBaseUrl(configuredBaseUrl?: string, browserOrigin?: string): string {
  const configured = configuredBaseUrl?.trim();
  if (configured) return trimTrailingSlash(configured);

  const origin = browserOrigin?.trim();
  if (origin) return trimTrailingSlash(origin);

  return LOOPBACK_FALLBACK;
}

export function joinRuntimeUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimTrailingSlash(baseUrl)}${normalizedPath}`;
}

const browserOrigin = typeof window === "undefined" ? undefined : window.location.origin;

export const API_BASE_URL = resolveRuntimeBaseUrl(
  import.meta.env?.VITE_API_BASE_URL,
  browserOrigin,
);

export const AG_UI_URL =
  import.meta.env?.VITE_AG_UI_URL?.trim() || joinRuntimeUrl(API_BASE_URL, "/api/agent");

export function apiUrl(path: string): string {
  return joinRuntimeUrl(API_BASE_URL, path);
}

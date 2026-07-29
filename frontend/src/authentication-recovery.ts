export interface AuthenticationRequiredEvent {
  status: 401;
  url: string;
}

type AuthenticationRequiredListener = (event: AuthenticationRequiredEvent) => void;

const listeners = new Set<AuthenticationRequiredListener>();

/**
 * Observe edge or Product Identity authentication failures without making any
 * feature component own the login lifecycle.
 */
export function subscribeAuthenticationRequired(
  listener: AuthenticationRequiredListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Shared fetch boundary for REST and AG-UI. A 401 is returned unchanged to the
 * caller, while the App Shell receives one explicit authentication event.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const response = await fetchImplementation(input, {
    ...init,
    credentials: init.credentials ?? "same-origin",
  });
  if (response.status === 401) {
    const event = { status: 401 as const, url: requestUrl(input) };
    for (const listener of listeners) listener(event);
  }
  return response;
}

export function authenticationRecoveryUrl(baseUrl = import.meta.env.BASE_URL): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBase}auth-refresh.html`;
}

/**
 * A top-level navigation is required so an HTTP Basic Auth edge can show its
 * browser-managed credential challenge. The target is excluded from Workbox.
 */
export function beginAuthenticationRecovery(): void {
  window.location.assign(authenticationRecoveryUrl());
}

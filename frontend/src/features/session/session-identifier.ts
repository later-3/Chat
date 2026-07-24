/** Human-facing locator for a Product Session; the UUID remains authoritative. */
export function productSessionLocator(sessionId: string): string {
  const compact = sessionId.replaceAll("-", "").slice(0, 8).toUpperCase();
  return compact ? `PS-${compact}` : "PS-未知";
}

export async function copyProductSessionId(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await navigator.clipboard.writeText(sessionId);
}

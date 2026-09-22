/**
 * Per-participation-Session execution queue.
 *
 * A member's participation Session is a single native Pi Session; two model turns must never run in
 * it at the same time. This serializes execution inside one Backend process (the deployment boundary
 * for a shared Chat Home), independent of the per-attempt state machine.
 */
const tails = new Map<string, Promise<void>>();

export function participationTurnKey(storageProjectId: string, sessionId: string): string {
  return `${storageProjectId}\0${sessionId}`;
}

export async function withParticipationTurnLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

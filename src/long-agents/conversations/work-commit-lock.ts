/**
 * Arbitration lock for a group work's status commits.
 *
 * Cancellation and result publication must be linearizable with respect to each other: whichever side
 * acquires this lock first wins. The publication path holds it across "re-read status → decide →
 * append reference", so a cancellation that already committed cannot be bypassed by a stale status
 * read, and a cancellation that arrives later queues behind the commit instead of racing it.
 *
 * Lock order is always public-root Session lock → work commit lock. `cancelConversationWork` takes
 * only this lock, so the two paths cannot deadlock, and the lock is never held while waiting for a
 * model or an abort.
 */
const tails = new Map<string, Promise<void>>();

export function workCommitKey(storageProjectId: string, conversationId: string): string {
  return `${storageProjectId}\0${conversationId}`;
}

/** Acquire the lock and return its release function. Callers must release in a `finally`. */
export async function acquireWorkCommitLock(key: string): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  return () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

interface SessionOperationQueue {
  tail: Promise<void>;
  readonly owners: Set<{ readonly longAgentId: string }>;
}
const sessionOperationTails = new Map<string, SessionOperationQueue>();

export function chatSessionOperationKey(projectId: string, sessionId: string): string {
  return `${projectId}\0${sessionId}`;
}
/** Serializes Workflow starts and lifecycle mutations for one Project Session. */
export async function withChatSessionOperationLock<T>(
  key: string,
  operation: () => Promise<T>,
  owner?: { readonly longAgentId: string },
): Promise<T> {
  const queue = sessionOperationTails.get(key) ?? { tail: Promise.resolve(), owners: new Set() };
  const previous = queue.tail;
  // Ownership annotates the existing lock, including queued work. It is not a
  // separate runtime registry and survives primary-Session rotation.
  const entry = owner ? { longAgentId: owner.longAgentId } : undefined;
  if (entry) queue.owners.add(entry);
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  queue.tail = tail;
  sessionOperationTails.set(key, queue);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (entry) queue.owners.delete(entry);
    if (queue.tail === tail) sessionOperationTails.delete(key);
  }
}

/** True while a Session operation is active or queued in this Backend process. */
export function isChatSessionOperationBusy(projectId: string, sessionId: string): boolean {
  return sessionOperationTails.has(chatSessionOperationKey(projectId, sessionId));
}

/** A snapshot of Long Agent ownership on active/queued native Session operations. */
export function busyLongAgentIds(): ReadonlySet<string> {
  return new Set([...sessionOperationTails.values()].flatMap(queue => [...queue.owners].map(owner => owner.longAgentId)));
}

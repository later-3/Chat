const sessionOperationTails = new Map<string, Promise<void>>();

export function chatSessionOperationKey(projectId: string, sessionId: string): string {
  return `${projectId}\0${sessionId}`;
}
/** Serializes Workflow starts and lifecycle mutations for one Project Session. */
export async function withChatSessionOperationLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sessionOperationTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  sessionOperationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sessionOperationTails.get(key) === tail) sessionOperationTails.delete(key);
  }
}

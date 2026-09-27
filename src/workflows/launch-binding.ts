import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { getWorld } from "workflow/runtime";

type World = ReturnType<typeof getWorld>;
type QueueArgs = Parameters<World["queue"]>;

function journalPath(projectDataDir: string, invocationId: string): string {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(invocationId)) throw new Error("无效Workflow invocation身份");
  return resolve(projectDataDir, "workflows", "dispatch", `${invocationId}.bin`);
}

/**
 * start() creates and queues concurrently. Persist its PUBLIC queue arguments and Chat binding before
 * allowing the queue call through. A restart re-dispatches the SAME SDK run id, never calls start twice.
 * The opaque serialized input belongs to Workflow; Chat does not parse/reimplement its execution state.
 */
export function bindWorkflowLaunch(input: {
  readonly projectDataDir: string;
  readonly invocationId: string;
  readonly bind: (runId: string) => Promise<void>;
}, world: World = getWorld()): World {
  const wrapper: World = Object.create(world) as World;
  wrapper.queue = async (...args: QueueArgs) => {
    // SDK 4.8 carries runInput in its queue payload, so its native worker can recover even
    // when concurrent run_created has not completed. Preserve that SDK contract unchanged.
    const [, payload] = args;
    if (typeof payload !== "object" || payload === null || !("runId" in payload)
      || typeof payload.runId !== "string") throw new Error("Workflow启动缺少Run身份");
    const path = journalPath(input.projectDataDir, input.invocationId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialize(args), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    await input.bind(payload.runId);
    return world.queue(...args);
  };
  return wrapper;
}

export async function finishWorkflowLaunch(projectDataDir: string, invocationId: string): Promise<void> {
  await unlink(journalPath(projectDataDir, invocationId)).catch(error => { if (error.code !== "ENOENT") throw error; });
}

export async function resumeWorkflowLaunch(projectDataDir: string, invocationId: string,
  bind: (runId: string) => Promise<void>, world?: World): Promise<string | undefined> {
  let bytes: Buffer;
  try { bytes = await readFile(journalPath(projectDataDir, invocationId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const value: unknown = deserialize(bytes);
  if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "object"
    || value[1] === null || typeof value[1].runId !== "string") throw new Error("Workflow派发日志损坏");
  const args = value as QueueArgs;
  const runId: string = value[1].runId;
  await bind(runId);
  await (world ?? getWorld()).queue(...args);
  await finishWorkflowLaunch(projectDataDir, invocationId);
  return runId;
}

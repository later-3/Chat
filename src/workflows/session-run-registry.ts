import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getRun } from "workflow/api";

export interface ChatSessionRunBinding {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly workflowInvocationId: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly startedAt: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBinding(value: unknown): ChatSessionRunBinding {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Workflow Run绑定版本无效");
  for (const field of ["runId", "workflowInvocationId", "workflowId", "projectId", "sessionId", "startedAt"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new Error(`Workflow Run绑定${field}无效`);
    }
  }
  if (Number.isNaN(Date.parse(value.startedAt as string))) throw new Error("Workflow Run绑定startedAt无效");
  return {
    schemaVersion: 1,
    runId: value.runId as string,
    workflowInvocationId: value.workflowInvocationId as string,
    workflowId: value.workflowId as string,
    projectId: value.projectId as string,
    sessionId: value.sessionId as string,
    startedAt: value.startedAt as string,
  };
}

function runBindingsDirectory(projectDataDir: string): string {
  return resolve(projectDataDir, "workflows", "runs");
}

function bindingPath(projectDataDir: string, workflowInvocationId: string): string {
  return resolve(runBindingsDirectory(projectDataDir), `${workflowInvocationId}.json`);
}

export async function recordChatSessionRunBinding(
  projectDataDir: string,
  binding: Omit<ChatSessionRunBinding, "schemaVersion" | "startedAt">,
): Promise<ChatSessionRunBinding> {
  const value: ChatSessionRunBinding = {
    schemaVersion: 1,
    ...binding,
    startedAt: new Date().toISOString(),
  };
  const directory = runBindingsDirectory(projectDataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = bindingPath(projectDataDir, value.workflowInvocationId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return value;
}

async function listBindings(projectDataDir: string): Promise<ChatSessionRunBinding[]> {
  const directory = runBindingsDirectory(projectDataDir);
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const bindings = await Promise.all(names.map(async (name) => {
    try {
      return parseBinding(JSON.parse(await readFile(resolve(directory, name), "utf8")));
    } catch {
      return undefined;
    }
  }));
  return bindings.filter((binding): binding is ChatSessionRunBinding => binding !== undefined);
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Checks durable Chat bindings while Workflow Runtime remains the status source. */
export async function findActiveChatSessionRun(
  projectDataDir: string,
  sessionId: string,
): Promise<(ChatSessionRunBinding & { readonly status: string }) | undefined> {
  const candidates = (await listBindings(projectDataDir))
    .filter((binding) => binding.sessionId === sessionId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  for (const binding of candidates) {
    try {
      const status = String(await getRun(binding.runId).status);
      if (!isTerminalRunStatus(status)) return { ...binding, status };
    } catch {
      // Missing Runtime state is not evidence of an active writer.
    }
  }
  return undefined;
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../../persistence/versioned-file.js";
import { longAgentConfigRoot } from "../storage.js";
import { FriendArtifactError, parseArtifact, type FriendArtifact } from "./contract.js";

export interface ArtifactState {
  schemaVersion: 1;
  artifacts: FriendArtifact[];
}
export function artifactFile(home: string, agent: string) {
  return resolve(longAgentConfigRoot(home, agent), "artifacts.json");
}
export async function readArtifactState(home: string, agent: string): Promise<ArtifactState> {
  const file = artifactFile(home, agent);
  await assertFileWithin(file, home);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, artifacts: [] };
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("产物存储格式无效");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.artifacts)) throw new Error("产物存储格式无效");
  const artifacts = record.artifacts.map(parseArtifact);
  if (artifacts.some((artifact) => artifact.longAgentId !== agent))
    throw new Error("产物存储归属冲突");
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length)
    throw new Error("产物存储包含重复身份");
  return { schemaVersion: 1, artifacts };
}
export async function changeArtifactState<T>(home: string, agent: string, change: (state: ArtifactState) => Promise<T> | T): Promise<T> {
  return withFileLock(artifactFile(home, agent), async () => {
    const state = await readArtifactState(home, agent);
    const result = await change(state);
    await atomicWriteJson(artifactFile(home, agent), state);
    return result;
  });
}
export function requireArtifact(state: ArtifactState, artifactId: string): FriendArtifact {
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) throw new FriendArtifactError(404, "找不到该产物");
  return artifact;
}

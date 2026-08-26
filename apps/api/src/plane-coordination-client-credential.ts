import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const PLANE_CLIENT_CREDENTIAL_PATTERN = /^pck_[A-Za-z0-9-]{16,128}$/u;

export class PlaneCoordinationClientCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaneCoordinationClientCredentialError";
  }
}

function canonicalPrivatePath(value: string, key: string): string {
  if (!isAbsolute(value)) {
    throw new PlaneCoordinationClientCredentialError(`${key}必须是绝对路径`);
  }
  const normalized = resolve(value);
  if (normalized !== value) {
    throw new PlaneCoordinationClientCredentialError(`${key}必须是不含.或..的规范绝对路径`);
  }
  let existing = normalized;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (existsSync(existing) && realpathSync(existing) !== existing) {
    throw new PlaneCoordinationClientCredentialError(`${key}的现有父链不能包含symlink`);
  }
  return normalized;
}

export function planeCoordinationClientCredentialPath(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH?.trim();
  if (configured !== undefined && configured !== "") {
    return canonicalPrivatePath(configured, "CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH");
  }
  return canonicalPrivatePath(
    resolve(repoRoot, ".data/runtime/plane-client-key"),
    "Plane客户端凭据默认路径",
  );
}

async function readSecureCredential(filePath: string): Promise<string | undefined> {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PlaneCoordinationClientCredentialError("Plane客户端凭据必须是非symlink普通文件");
  }
  if ((await realpath(dirname(filePath))) !== dirname(filePath)) {
    throw new PlaneCoordinationClientCredentialError("Plane客户端凭据父链不能包含symlink");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new PlaneCoordinationClientCredentialError("Plane客户端凭据必须由当前用户拥有");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new PlaneCoordinationClientCredentialError("Plane客户端凭据权限必须禁止group/world访问");
  }
  const credential = (await readFile(filePath, "utf8")).trim();
  if (!PLANE_CLIENT_CREDENTIAL_PATTERN.test(credential)) {
    throw new PlaneCoordinationClientCredentialError("Plane客户端凭据内容非法");
  }
  return credential;
}

/**
 * 为Codex等受信本机客户端生成独立窄凭据；它不是Plane Token，也不能访问私有Runtime Router。
 */
export async function loadPlaneCoordinationClientCredential(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = planeCoordinationClientCredentialPath(repoRoot, environment);
  const existing = await readSecureCredential(filePath);
  if (existing !== undefined) return existing;

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(filePath))) !== dirname(filePath)) {
    throw new PlaneCoordinationClientCredentialError("Plane客户端凭据父链不能包含symlink");
  }
  const credential = `pck_${randomUUID().replaceAll("-", "")}`;
  try {
    await writeFile(filePath, `${credential}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return credential;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      const raced = await readSecureCredential(filePath);
      if (raced !== undefined) return raced;
    }
    throw new PlaneCoordinationClientCredentialError("无法创建或读取Plane客户端凭据");
  }
}

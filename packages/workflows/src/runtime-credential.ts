import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/**
 * 仅服务端持有的Runtime凭据（任务书§10、§12.4）。
 *
 * 用途：API私有Runtime Router与Workflow Runtime分发端点的共享凭据。
 * - 优先读取CHAT_RUNTIME_KEY环境变量（.env，不入库）。
 * - 缺省时在<repoRoot>/.data/runtime/runtime-key原子创建随机凭据（0600），
 *   API与Workflow进程读取同一文件；.data已gitignore。
 * - 浏览器CORS、公开Router和前端Bundle都不能获得该凭据。
 * - 不打印、不进入Trace、不写入任何提交。
 */

export class RuntimeCredentialError extends Error {
  readonly code = "runtime_credential_invalid";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCredentialError";
  }
}

const CREDENTIAL_PATTERN = /^rtk_[A-Za-z0-9-]{16,128}$/;

export async function loadRuntimeCredential(repoRoot: string): Promise<string> {
  const fromEnv = process.env.CHAT_RUNTIME_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    if (!CREDENTIAL_PATTERN.test(fromEnv)) {
      throw new RuntimeCredentialError("CHAT_RUNTIME_KEY格式非法（期望rtk_前缀随机串）");
    }
    return fromEnv;
  }
  const dir = `${repoRoot}/.data/runtime`;
  const filePath = `${dir}/runtime-key`;
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (CREDENTIAL_PATTERN.test(existing)) return existing;
    throw new RuntimeCredentialError("Runtime凭据文件内容非法，失败关闭");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
    if (error instanceof RuntimeCredentialError) throw error;
  }
  await mkdir(dirname(filePath), { recursive: true });
  const credential = `rtk_${randomUUID().replaceAll("-", "")}`;
  try {
    await writeFile(filePath, credential, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return credential;
  } catch (error) {
    // 并发创建：另一个进程已写入，读取其内容
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      const existing = (await readFile(filePath, "utf8")).trim();
      if (CREDENTIAL_PATTERN.test(existing)) return existing;
    }
    throw new RuntimeCredentialError("无法创建或读取Runtime凭据");
  }
}

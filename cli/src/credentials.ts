import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { record, string } from "./contract.js";

export function clientHome(): string { return process.env.CHAT_CLI_HOME ?? join(homedir(), ".chat-client"); }
function credentialPath(url: string): string { return join(clientHome(), `${createHash("sha256").update(url).digest("hex")}.json`); }
export async function readCookie(url: string): Promise<string> {
  try {
    const data = record(JSON.parse(await readFile(credentialPath(url), "utf8")));
    const expiresAt = Date.parse(string(data.expiresAt));
    if (data.schemaVersion !== 1 || data.url !== url || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return "";
    const cookie = string(data.cookie);
    if (!/^chat-session=[^;\r\n]+$/.test(cookie)) throw new Error("登录记录无效，请重新登录");
    return cookie;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export async function saveCookie(url: string, data: { cookie: string; expiresAt: string }): Promise<void> {
  const home = clientHome(); await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700);
  const path = credentialPath(url); const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify({ schemaVersion: 1, url, ...data }), { mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
}
export async function removeCookie(url: string): Promise<void> {
  await unlink(credentialPath(url)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
}

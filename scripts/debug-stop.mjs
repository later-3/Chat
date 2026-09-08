import { readFile, realpath, access, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ports, debugRoot, assertPortFree } from "./debug-environment.mjs";
import { controlRole, stopRole, identity } from "./debug-processes.mjs";

export async function stopDebug({ check = false, roles = ["stack", "nanoclaw", "frontend", "backend", "model"], log = console.log } = {}) {
  for (const role of roles) if (role !== "stack" && !Object.hasOwn(ports, role)) throw new Error(`Unknown debug role: ${role}`);
  let exists = true;
  try { await access(debugRoot); if (await realpath(debugRoot) !== debugRoot) throw new Error("Debug root must not be redirected"); }
  catch (error) { if (error.code === "ENOENT") exists = false; else throw error; }
  log(`[调试] ${check ? "只检查，不关闭" : "检查并关闭自有调试进程"}: ${debugRoot}`);
  let ok = true;
  for (const role of roles) {
    try {
      let record;
      try {
        const path = `${debugRoot}/${role}.lock`;
        if ((await lstat(path)).isSymbolicLink()) throw new Error("Debug ownership records must not be symlinks");
        record = JSON.parse(await readFile(path, "utf8"));
      }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const pid = typeof record === "number" ? record : record?.owner?.pid;
      if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) throw new Error("Invalid debug owner PID");
      let busy = false;
      if (role !== "stack") { try { await assertPortFree(ports[role]); } catch { busy = true; } }
      log(`[检查] ${role}: 记录PID=${pid ?? "-"}, 进程=${pid && identity(pid) ? "存在" : "无"}${role === "stack" ? "" : `, 端口=${ports[role]}(${busy ? "占用" : "空闲"})`}`);
      if (check) continue;
      if (exists) {
        log(`[关闭] ${role}: 校验归属并停止；不按端口杀无关进程`);
        await controlRole(debugRoot, role, () => stopRole(debugRoot, role, () => role === "stack" ? Promise.resolve() : assertPortFree(ports[role])));
      } else if (busy) throw new Error("没有归属记录但端口占用，无法安全关闭");
      log(`[结果] ${role} 已停止${role === "stack" ? "" : `，端口 ${ports[role]} 空闲`}`);
    } catch (error) { ok = false; log(`[失败] ${role}: ${error.message}`); }
  }
  log(`[调试] ${check ? "检查完成" : ok ? "所选调试进程已停止，数据保留" : "未全部关闭；请处理失败项后重试"}`);
  return ok;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (!await stopDebug({ check: args.includes("--check"), ...(args.some(arg => arg !== "--check") ? { roles: args.filter(arg => arg !== "--check") } : {}) })) process.exitCode = 1;
}

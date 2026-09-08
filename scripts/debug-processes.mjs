import { execFileSync } from "node:child_process";
import { readFile, writeFile, unlink, rename, lstat, mkdir, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// PID alone is not ownership: retain its OS start time, group and uid to reject reuse.
export function identity(pid) {
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "pid=,pgid=,uid=,lstart=,stat="],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = text.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+\d{4})\s+(\S+)$/);
    if (!match || match[5].startsWith("Z")) return null;
    return { pid: Number(match[1]), group: Number(match[2]), uid: Number(match[3]), started: match[4].replace(/\s+/g, " ") };
  } catch (error) { if (error.status === 1) return null; throw error; }
}
function same(record) {
  if (!record || record.uid !== process.getuid()) return false;
  const current = identity(record.pid);
  return current && current.started === record.started && current.uid === record.uid && current.group === record.group;
}
export function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") {
      const rows = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
      if (!rows.trim().split("\n").some(row => {
        const [group, state] = row.trim().split(/\s+/);
        return Number(group) === pid && !state.startsWith("Z");
      })) return false;
    }
    throw error;
  }
}
export async function stopGroup(pid) {
  signalGroup(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    if (!signalGroup(pid, 0)) return;
    await delay(100);
  }
  signalGroup(pid, "SIGKILL");
  for (let i = 0; i < 30; i++) {
    if (!signalGroup(pid, 0)) return;
    await delay(100);
  }
  throw new Error(`Owned process group ${pid} did not exit`);
}
async function read(path) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Debug ownership records must not be symlinks");
    return await readFile(path, "utf8");
  }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function removeIfSame(path, original) {
  if (await read(path) === original) await unlink(path);
}

/** Serialize recovery/start/stop for one role; independent roles may start together. */
export async function controlRole(root, role, action) {
  const path = join(root, `${role}.control`);
  const value = JSON.stringify({ owner: identity(process.pid), token: randomUUID() });
  for (let attempt = 0; ; attempt++) {
    try { await writeFile(path, value, { flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== "EEXIST" || attempt > 1) throw error;
      // Serialize stale-file deletion as well as normal acquisition. Two
      // recoverers must not unlink a fresh owner's lock after a stale read.
      const recovery = `${path}.recovery`;
      try { await mkdir(recovery, { mode: 0o700 }); }
      catch (error) {
        if (error.code === "EEXIST") throw new Error(`Debug ${role} control recovery already in progress; inspect its marker if the recovery process crashed`);
        throw error;
      }
      try {
        const previous = await read(path);
        if (!previous) throw new Error(`Debug ${role} control operation is starting; retry shortly`);
        const record = JSON.parse(previous);
        if (same(record.owner)) throw new Error(`Debug ${role} start/stop already in progress`);
        await removeIfSame(path, previous);
      } finally { await rmdir(recovery); }
    }
  }
  try { return await action(); }
  finally { await removeIfSame(path, value); }
}

/** Must run under controlRole. Unknown occupants are never signalled. */
export async function stopRole(root, role, portFree, replace = true) {
  const path = join(root, `${role}.lock`);
  let original = await read(path);
  if (original === null) { await portFree(); return; }
  const record = JSON.parse(original);
  if (typeof record === "number") {
    if (identity(record)) throw new Error(`Legacy ${role} owner ${record} is alive; stop that old debug session first`);
    await portFree();
    await removeIfSame(path, original);
    return;
  }
  if (record.schema !== 1 || record.role !== role || record.root !== root) throw new Error(`Invalid debug ${role} ownership record`);
  if (same(record.owner)) {
    if (!replace) throw new Error(`Debug ${role} is already running`);
    console.log(`[debug] stopping owned ${role} launcher ${record.owner.pid}`);
    process.kill(record.owner.pid, "SIGTERM");
    for (let i = 0; i < 120 && same(record.owner); i++) await delay(100);
    if (same(record.owner)) {
      // A paused debugger/launcher cannot run JS signal handlers. Escalate only
      // after rechecking the recorded OS identities, never by occupied port.
      if (record.child && same(record.child)) await stopGroup(record.child.pid);
      else if (record.child && signalGroup(record.child.pid, 0)) throw new Error("Paused owner's child group cannot be identified");
      if (same(record.owner)) process.kill(record.owner.pid, "SIGKILL");
      for (let i = 0; i < 30 && same(record.owner); i++) await delay(100);
      if (same(record.owner)) throw new Error(`Debug ${role} launcher did not stop; ownership retained`);
    }
    // The normal owner has already reaped its group and removed the lock.
    original = await read(path);
    if (original === null) { await portFree(); return; }
    if (JSON.parse(original).token !== record.token) throw new Error(`Debug ${role} owner changed during stop`);
  }
  if (record.child && same(record.child)) {
    if (record.child.group !== record.child.pid) throw new Error("Refusing an unowned process group");
    console.log(`[debug] recovering orphan ${role} group ${record.child.pid}`);
    await stopGroup(record.child.pid);
  } else if (record.child && signalGroup(record.child.pid, 0)) {
    throw new Error(`Debug ${role} group survives without its recorded leader; cannot prove ownership`);
  }
  await portFree();
  await removeIfSame(path, original);
}
export async function claimRole(root, role, portFree, replace = true) {
  {
    await stopRole(root, role, portFree, replace);
    const path = join(root, `${role}.lock`);
    const record = { schema: 1, root, role, token: randomUUID(), owner: identity(process.pid), child: null };
    await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    return {
      async attach(pid) {
        record.child = identity(pid);
        if (!record.child || record.child.group !== pid) throw new Error("Cannot identify owned debug child");
        const temporary = `${path}.${record.token}.tmp`;
        await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      },
      async release() {
        const current = await read(path);
        if (current && JSON.parse(current).token === record.token) await unlink(path);
      },
    };
  }
}

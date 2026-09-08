import { prepareDebug, ports, debugRoot, assertPortFree } from "./debug-environment.mjs";
import { controlRole, stopRole } from "./debug-processes.mjs";
await prepareDebug();
const roles = process.argv.slice(2).filter(value => value !== "--");
for (const role of roles.length ? roles : ["stack", "nanoclaw", "frontend", "backend", "model"]) {
  if (role !== "stack" && !Object.hasOwn(ports, role)) throw new Error(`Unknown debug role: ${role}`);
  await controlRole(debugRoot, role, () => stopRole(debugRoot, role, () => role === "stack" ? Promise.resolve() : assertPortFree(ports[role])));
  console.log(`[debug] ${role} stopped; ${role === "stack" ? "owned launchers released" : `port ${ports[role]} free`}`);
}

import { build, createDevServer, createNitro, prepare } from "nitro/builder";
import { debugRoot, ports, repositoryRoot } from "./debug-environment.mjs";
import { join } from "node:path";

// The same Nitro builder/dev server as `nitro dev`. Disable automatic root .env
// loading so a normal installation cannot supply credentials to the debug instance.
const nitro = await createNitro({
  rootDir: repositoryRoot, dev: true,
  buildDir: join(repositoryRoot, "node_modules/.nitro-debug"),
  output: { dir: join(debugRoot, "output"), serverDir: join(debugRoot, "output/server"), publicDir: join(debugRoot, "output/public") },
}, { dotenv: false });
const server = createDevServer(nitro);
await server.listen({ port: ports.backend, hostname: "127.0.0.1" });
await prepare(nitro);
await build(nitro);
// Listening alone is insufficient: wait for the first built worker to answer HTTP.
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${ports.backend}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(accept => setTimeout(accept, 100));
}
if (!ready) { await nitro.close(); throw new Error("Debug Backend did not become healthy"); }
console.log(`Chat debug backend ready: http://127.0.0.1:${ports.backend}/`);
// Source changes are watched by the builder. Restart F5 after nitro.config.ts changes.
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  await nitro.close();
  process.exit(0);
});

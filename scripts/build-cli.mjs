import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// A clean output directory prevents removed commands from remaining in tarballs.
const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../cli/dist/", import.meta.url), { recursive: true, force: true });
const compiler = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "-p", "cli/tsconfig.json"], { cwd: root, stdio: "inherit" });
compiler.once("error", error => { console.error(error.message); process.exitCode = 1; });
compiler.once("exit", code => { process.exitCode = code ?? 1; });

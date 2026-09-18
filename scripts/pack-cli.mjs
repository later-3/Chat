import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await mkdir(".data/cli-packages", { recursive: true });
const result = spawnSync("npm", ["pack", "./cli", "--pack-destination", ".data/cli-packages"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

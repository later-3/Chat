import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(repositoryRoot, "frontend");
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function readPackageVersion(relativePath) {
  const packagePath = resolve(repositoryRoot, relativePath);
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof metadata.version !== "string" || !versionPattern.test(metadata.version)) {
    throw new Error(`Invalid package version in ${packagePath}`);
  }
  return metadata.version;
}

const frontendArguments = process.argv.slice(2);
if (frontendArguments.length === 0) {
  throw new Error("Expected a frontend package command, such as build or dev");
}

const [appVersion, piVersion] = await Promise.all([
  readPackageVersion("frontend/package.json"),
  readPackageVersion("pi/packages/coding-agent/package.json"),
]);

const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpmExecutable, ["--dir", frontendRoot, ...frontendArguments], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    VITE_APP_VERSION: appVersion,
    VITE_PI_VERSION: piVersion,
  },
  stdio: "inherit",
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

process.exitCode = exitCode;

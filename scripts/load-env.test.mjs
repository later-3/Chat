import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

async function inspectRole(preload, envFile, extraEnvironment = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      join(repoRoot, "scripts", preload),
      "--input-type=module",
      "--eval",
      "console.log(JSON.stringify({role:process.env.CHAT_RUNTIME_ROLE,token:process.env.CHAT_PLANE_CE_API_TOKEN,baseUrl:process.env.CHAT_PLANE_CE_BASE_URL,creationRoots:process.env.CHAT_PROJECT_CREATION_ROOTS_JSON}))",
    ],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        CHAT_ENV_FILE: envFile,
        CHAT_REPO_ROOT: repoRoot,
        ...extraEnvironment,
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(stdout);
}

test("同一外置配置文件只把Plane Credential加载进API角色", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chat-role-env-")));
  try {
    const envFile = join(directory, "runtime.env");
    await writeFile(
      envFile,
      [
        "CHAT_PLANE_ENABLED=1",
        "CHAT_PLANE_CE_API_TOKEN=plane-role-canary",
        "CHAT_PLANE_CE_BASE_URL=http://127.0.0.1:8088",
      ].join("\n"),
      { mode: 0o600 },
    );
    assert.deepEqual(await inspectRole("load-api-env.mjs", envFile), {
      role: "api",
      token: "plane-role-canary",
      baseUrl: "http://127.0.0.1:8088",
    });
    assert.deepEqual(await inspectRole("load-pi-executor-env.mjs", envFile), {
      role: "piExecutor",
      baseUrl: "http://127.0.0.1:8088",
    });
    assert.deepEqual(await inspectRole("load-supervisor-env.mjs", envFile), {
      role: "supervisor",
      baseUrl: "http://127.0.0.1:8088",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("未开启外部事项Provider时父环境和配置文件都不能注入其运行配置", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chat-ambient-plane-token-")));
  try {
    const envFile = join(directory, "runtime.env");
    await writeFile(envFile, "CHAT_PLANE_CE_BASE_URL=http://127.0.0.1:8088\n", { mode: 0o600 });
    assert.deepEqual(
      await inspectRole("load-pi-executor-env.mjs", envFile, {
        CHAT_PLANE_CE_API_TOKEN: "ambient-token-must-be-deleted",
      }),
      { role: "piExecutor" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("默认配置不能注入外部事项Provider或旧项目创建面", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chat-disabled-plane-env-")));
  try {
    const envFile = join(directory, "runtime.env");
    await writeFile(
      envFile,
      [
        "CHAT_PLANE_CE_API_TOKEN=must-not-load",
        "CHAT_PLANE_CE_BASE_URL=http://127.0.0.1:8088",
        'CHAT_PROJECT_CREATION_ROOTS_JSON=\'[{"rootId":"root_customer"}]\'',
      ].join("\n"),
      { mode: 0o600 },
    );
    assert.deepEqual(await inspectRole("load-supervisor-env.mjs", envFile), {
      role: "supervisor",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("外置配置拒绝group/world权限和symlink，不能静默加载Secret", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chat-insecure-env-")));
  try {
    const envFile = join(directory, "runtime.env");
    await writeFile(envFile, "CHAT_PLANE_CE_API_TOKEN=must-not-load\n", { mode: 0o600 });
    await chmod(envFile, 0o644);
    await assert.rejects(inspectRole("load-api-env.mjs", envFile), /group\/world/u);

    await chmod(envFile, 0o600);
    const link = join(directory, "runtime-link.env");
    await symlink(envFile, link);
    await assert.rejects(inspectRole("load-api-env.mjs", link), /symlink/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("所有Secret路径必须是跨进程cwd一致的绝对路径", async () => {
  await assert.rejects(inspectRole("load-api-env.mjs", "relative-runtime.env"), /绝对路径/u);

  const directory = await realpath(await mkdtemp(join(tmpdir(), "chat-relative-secret-path-")));
  try {
    const envFile = join(directory, "runtime.env");
    await writeFile(
      envFile,
      [
        "CHAT_PLANE_ENABLED=1",
        "CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH=.data/runtime/plane-client-key",
      ].join("\n"),
      { mode: 0o600 },
    );
    await assert.rejects(inspectRole("load-api-env.mjs", envFile), /绝对路径/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Secret路径拒绝dot segment与现有父链symlink", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "chat-canonical-secret-path-")));
  try {
    const envFile = join(directory, "runtime.env");
    await writeFile(envFile, "CHAT_PLANE_CE_BASE_URL=http://127.0.0.1:8088\n", { mode: 0o600 });
    await assert.rejects(
      inspectRole("load-api-env.mjs", `${directory}/private/../runtime.env`),
      /规范绝对路径/u,
    );

    const actual = join(directory, "actual");
    const linked = join(directory, "linked-parent");
    await mkdir(actual);
    await symlink(actual, linked);
    const configuredPath = join(linked, "plane-client-key");
    await writeFile(
      envFile,
      [
        "CHAT_PLANE_ENABLED=1",
        `CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH=${configuredPath}`,
      ].join("\n"),
      { mode: 0o600 },
    );
    await assert.rejects(inspectRole("load-api-env.mjs", envFile), /symlink/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

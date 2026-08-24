import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { assertDshPluginRegistry } from "../dsh/plugin-registry.mjs";
import {
  assertDshWebCutoverConfig,
  dshBridgeInstallArgs,
  dshMobileShellInstallArgs,
  resolveDshBin,
  resolveDshWebRuntime,
  runCommand,
  runCommandOutput,
} from "../dsh/profile-runtime.mjs";
import {
  DSH_PROMPT_STUDIO_E2E_PORTS,
  DSH_PROMPT_THREE_GATES_E2E_PORTS,
  DSH_PROJECT_BOOTSTRAP_E2E_PORTS,
  DSH_REAL_E2E_PORTS,
  dshRealWebEnvironment,
  resolveDshRealSharedCacheRoot,
  resolveDshRealWorkbenchFixtureRoot,
} from "./dsh-real-environment.mjs";
import { cleanupDshRealWorkbench } from "./dsh-real-workbench-lifecycle.mjs";
import {
  FIXED_CODE_SERVER_VERSION,
  codeServerPlatformKey,
  fixedCodeServerAsset,
  validateCodeServerCache,
} from "../workbench/fixed-code-server.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
assertDshPluginRegistry(repoRoot);
const args = process.argv.slice(2);
const workbenchOnly = args.includes("--workbench-only");
// pwa-only 与 workbench-only 一样不装配付费Provider门；PWA 验证只覆盖
// Gateway/DSH 与公开静态资产。
const pwaOnly = args.includes("--pwa-only");
const trajectoryOnly = args.includes("--trajectory-only");
const promptStudioOnly = args.includes("--prompt-studio-only");
const promptThreeGatesOnly = args.includes("--prompt-three-gates-only");
const projectBootstrapOnly = args.includes("--project-bootstrap-only");
const dataRoot = resolve(
  repoRoot,
  promptThreeGatesOnly
    ? ".data/e2e/dsh-prompt-three-gates-real"
    : projectBootstrapOnly
      ? ".data/e2e/dsh-project-bootstrap-real"
      : ".data/e2e/dsh-real",
);
const expectedRoot = resolve(
  repoRoot,
  promptThreeGatesOnly
    ? ".data/e2e/dsh-prompt-three-gates-real"
    : projectBootstrapOnly
      ? ".data/e2e/dsh-project-bootstrap-real"
      : ".data/e2e/dsh-real",
);

async function assertE2ePortsFree(ports) {
  for (const port of ports) {
    const server = createServer();
    await new Promise((resolvePort, rejectPort) => {
      server.once("error", (error) => {
        rejectPort(
          new Error(
            `DSH E2E专属端口${String(port)}已被占用；测试拒绝清理未知进程或借用production端口`,
            { cause: error },
          ),
        );
      });
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close((error) => (error === undefined ? resolvePort() : rejectPort(error)));
      });
    });
  }
}

if (
  args.some(
    (argument) =>
      argument !== "--workbench-only" &&
      argument !== "--pwa-only" &&
      argument !== "--trajectory-only" &&
      argument !== "--prompt-studio-only" &&
      argument !== "--prompt-three-gates-only" &&
      argument !== "--project-bootstrap-only",
  )
) {
  throw new Error("DSH真实E2E preflight收到未知参数");
}
if (!workbenchOnly && !pwaOnly && !trajectoryOnly && !promptStudioOnly && !projectBootstrapOnly)
  await import("../debug/load-provider-env.mjs");

if (
  dataRoot !== expectedRoot ||
  ![
    "/.data/e2e/dsh-real",
    "/.data/e2e/dsh-prompt-three-gates-real",
    "/.data/e2e/dsh-project-bootstrap-real",
  ].some((suffix) => dataRoot.endsWith(suffix))
) {
  throw new Error("拒绝清理未通过精确校验的DSH真实E2E目录");
}
if (
  !workbenchOnly &&
  !pwaOnly &&
  !trajectoryOnly &&
  !promptStudioOnly &&
  !projectBootstrapOnly &&
  !process.env.DASHSCOPE_API_KEY?.trim()
) {
  throw new Error("真实DSH E2E缺少百炼凭据（本门失败关闭，不会Skip或切换替身）");
}

// 必须先用仍存在的受管evidence回收上轮wrapper/child/socket，再删除可再生目录；
// 反过来会永久丢失Unix socket进程身份，Ctrl-C后的PTY child将无法安全识别。
if (!promptThreeGatesOnly) {
  await cleanupDshRealWorkbench(repoRoot, { environment: process.env });
}
const reservedPorts = promptStudioOnly
  ? Object.values(DSH_PROMPT_STUDIO_E2E_PORTS)
  : promptThreeGatesOnly
    ? Object.values(DSH_PROMPT_THREE_GATES_E2E_PORTS)
    : projectBootstrapOnly
      ? Object.values(DSH_PROJECT_BOOTSTRAP_E2E_PORTS)
      : Object.values(DSH_REAL_E2E_PORTS);
await assertE2ePortsFree(reservedPorts);
rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
if (projectBootstrapOnly) {
  mkdirSync(join(dataRoot, "workspace-root"), { recursive: true });
}
const promptThreeGatesTempRoot = promptThreeGatesOnly
  ? resolve(repoRoot, ".data/e2e/dsh-t3-tmp")
  : undefined;
if (promptThreeGatesTempRoot !== undefined) {
  rmSync(promptThreeGatesTempRoot, { recursive: true, force: true });
  mkdirSync(promptThreeGatesTempRoot, { recursive: true });
}

const safeDshEnvironment = dshRealWebEnvironment(repoRoot, {
  ...process.env,
  CHAT_DSH_E2E_DATA_ROOT: dataRoot,
  ...(promptThreeGatesTempRoot === undefined
    ? {}
    : { CHAT_DSH_E2E_TEMP_ROOT: promptThreeGatesTempRoot }),
  ...(promptThreeGatesTempRoot === undefined
    ? {}
    : {
        TMPDIR: promptThreeGatesTempRoot,
        TMP: promptThreeGatesTempRoot,
        TEMP: promptThreeGatesTempRoot,
      }),
});
const runtime = resolveDshWebRuntime(repoRoot, safeDshEnvironment);
const toolHome = process.env.HOME?.trim();
if (toolHome === undefined || toolHome === "") {
  throw new Error("DSH E2E Profile准备缺少本地工具链HOME");
}
const environment = {
  ...safeDshEnvironment,
  // 只在Profile准备子进程复用已安装的Corepack包与pnpm内容寻址Store；最终DSH
  // Host仍只接收safeDshEnvironment，不获得用户HOME、Provider或账号环境。
  COREPACK_HOME: process.env.COREPACK_HOME?.trim() || join(toolHome, ".cache/node/corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_store_dir:
    process.env.npm_config_store_dir?.trim() ||
    (process.platform === "darwin"
      ? join(toolHome, "Library/pnpm/store/v10")
      : join(toolHome, ".local/share/pnpm/store/v10")),
};
// 独立版 pnpm（pkg 快照）在 TMPDIR/HOME 不存在时直接 ENOENT 崩溃；先落目录。
for (const dir of [environment.TMPDIR, environment.HOME, environment.XDG_CACHE_HOME]) {
  if (typeof dir === "string" && dir !== "") mkdirSync(dir, { recursive: true });
}

// PWA-only只验证DSH/Gateway/浏览器表面，不能因为没有下载数百MB的
// code-server或没有Workbench Git fixture而失败。其他两种真实门仍保留原完整合同。
if (
  !pwaOnly &&
  !trajectoryOnly &&
  !promptStudioOnly &&
  !promptThreeGatesOnly &&
  !projectBootstrapOnly
) {
  const workbenchFixtureRoot = resolveDshRealWorkbenchFixtureRoot(repoRoot);
  mkdirSync(workbenchFixtureRoot, { recursive: true });
  writeFileSync(join(workbenchFixtureRoot, ".gitignore"), ".data/\n", "utf8");
  writeFileSync(join(workbenchFixtureRoot, "fixture.txt"), "baseline from Workbench E2E\n", "utf8");
  await runCommand("git", ["init", "--quiet"], {
    cwd: workbenchFixtureRoot,
    env: environment,
    label: "Workbench E2E fixture Git初始化",
  });
  await runCommand("git", ["config", "user.name", "Chat Workbench E2E"], {
    cwd: workbenchFixtureRoot,
    env: environment,
    label: "Workbench E2E fixture Git用户",
  });
  await runCommand("git", ["config", "user.email", "workbench-e2e@invalid.local"], {
    cwd: workbenchFixtureRoot,
    env: environment,
    label: "Workbench E2E fixture Git邮箱",
  });
  await runCommand("git", ["add", ".gitignore", "fixture.txt"], {
    cwd: workbenchFixtureRoot,
    env: environment,
    label: "Workbench E2E fixture暂存",
  });
  await runCommand("git", ["commit", "--quiet", "-m", "baseline"], {
    cwd: workbenchFixtureRoot,
    env: environment,
    label: "Workbench E2E fixture基线提交",
  });

  const codeServerAsset = fixedCodeServerAsset();
  const codeServerCacheRoot = join(
    resolveDshRealSharedCacheRoot(repoRoot),
    "code-server",
    `v${FIXED_CODE_SERVER_VERSION}`,
    codeServerPlatformKey(),
  );
  if (!validateCodeServerCache({ cacheRoot: codeServerCacheRoot, asset: codeServerAsset })) {
    throw new Error(
      "真实DSH E2E缺少已验证的固定code-server缓存；请先运行 pnpm workbench:prepare:code-server",
    );
  }
}

// E2E profile和Workflow bundle都是测试专用可再生产物。先准备再交给
// Playwright监督真实服务，避免旧dist/profile让完成门假通过。
await runCommand(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@chat/dsh-lifeos-bridge", "build"],
  { cwd: repoRoot, env: environment, label: "DSH E2E Bridge构建" },
);
if (
  (!workbenchOnly && !pwaOnly && !trajectoryOnly && !promptStudioOnly && !projectBootstrapOnly) ||
  promptThreeGatesOnly
) {
  await runCommand(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "@chat/workflows", "build:bundles"],
    { cwd: repoRoot, env: environment, label: "DSH E2E Workflow Bundle构建" },
  );
}

const dshBin = resolveDshBin(repoRoot);
await runCommand(process.execPath, [dshBin, ...dshBridgeInstallArgs(runtime)], {
  cwd: repoRoot,
  env: environment,
  label: "DSH E2E Profile Bridge安装",
});
await runCommand(process.execPath, [dshBin, ...dshMobileShellInstallArgs(runtime)], {
  cwd: repoRoot,
  env: environment,
  label: "DSH E2E Profile 移动端外壳安装",
});
const dump = await runCommandOutput(process.execPath, [dshBin, "web", "--dump-config"], {
  cwd: repoRoot,
  env: environment,
  label: "DSH E2E Profile校验",
});
assertDshWebCutoverConfig(dump);

console.log(
  workbenchOnly
    ? "[e2e-preflight] rc.6 DSH profile、隔离Git Workbench fixture与固定code-server已就绪（未加载Provider，未构建Workflow）"
    : pwaOnly
      ? "[e2e-preflight] rc.6 DSH profile与PWA浏览器表面已就绪（未加载Provider/Workflow/Workbench）"
      : promptStudioOnly
        ? "[e2e-preflight] rc.6 DSH Prompt Studio已就绪（Pi只读配置已加载；未加载Provider/Workflow/Workbench）"
        : projectBootstrapOnly
          ? "[e2e-preflight] rc.6 DSH建项纵向已就绪（确定性Provider；未加载真实Plane/模型/Workflow/Workbench）"
          : promptThreeGatesOnly
            ? "[e2e-preflight] rc.6 DSH三闸门、真实Provider与Workflow Bundle已就绪（未启动Workbench/Memory）"
            : trajectoryOnly
              ? "[e2e-preflight] rc.6 DSH profile与原生Trajectory/会话记录表面已就绪（使用测试Trace Provider，不加载Provider/Workflow/Workbench）"
              : "[e2e-preflight] rc.6 DSH profile、真实Provider、隔离Git Workbench fixture与固定code-server已就绪",
);

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

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
  DSH_CAPABILITY_GOVERNANCE_E2E_PORTS,
  DSH_PLANNING_FAUX_E2E_PORTS,
  DSH_REAL_E2E_PORTS,
  dshRealWebEnvironment,
  managedDshE2eTemporaryRoot,
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
const capabilityGovernanceOnly = args.includes("--capability-governance-only");
const planningFauxOnly = args.includes("--planning-faux-only");
const paidMode =
  promptThreeGatesOnly ||
  (!workbenchOnly &&
    !pwaOnly &&
    !trajectoryOnly &&
    !promptStudioOnly &&
    !projectBootstrapOnly &&
    !capabilityGovernanceOnly &&
    !planningFauxOnly);
const dataRoot = resolve(
  repoRoot,
  promptThreeGatesOnly
    ? ".data/e2e/dsh-prompt-three-gates-real"
    : planningFauxOnly
      ? ".data/e2e/dsh-planning-faux-real"
      : projectBootstrapOnly
        ? ".data/e2e/dsh-project-bootstrap-real"
        : capabilityGovernanceOnly
          ? ".data/e2e/dsh-capability-governance-real"
          : ".data/e2e/dsh-real",
);
const expectedRoot = resolve(
  repoRoot,
  promptThreeGatesOnly
    ? ".data/e2e/dsh-prompt-three-gates-real"
    : planningFauxOnly
      ? ".data/e2e/dsh-planning-faux-real"
      : projectBootstrapOnly
        ? ".data/e2e/dsh-project-bootstrap-real"
        : capabilityGovernanceOnly
          ? ".data/e2e/dsh-capability-governance-real"
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
      argument !== "--project-bootstrap-only" &&
      argument !== "--capability-governance-only" &&
      argument !== "--planning-faux-only",
  )
) {
  throw new Error("DSH真实E2E preflight收到未知参数");
}
if (paidMode && process.env.CHAT_ALLOW_PAID_TESTS !== "1") {
  throw new Error("DSH付费门需要显式设置CHAT_ALLOW_PAID_TESTS=1");
}
if (paidMode && !process.env.CHAT_PAID_TEST_COMMAND_NAME?.includes(":paid")) {
  throw new Error("DSH付费门只能由名称包含:paid的受管命令启动");
}
if (paidMode) await import("../debug/load-provider-env.mjs");

if (
  dataRoot !== expectedRoot ||
  ![
    "/.data/e2e/dsh-real",
    "/.data/e2e/dsh-prompt-three-gates-real",
    "/.data/e2e/dsh-project-bootstrap-real",
    "/.data/e2e/dsh-capability-governance-real",
    "/.data/e2e/dsh-planning-faux-real",
  ].some((suffix) => dataRoot.endsWith(suffix))
) {
  throw new Error("拒绝清理未通过精确校验的DSH真实E2E目录");
}
if (paidMode && !process.env.DASHSCOPE_API_KEY?.trim()) {
  throw new Error("真实DSH E2E缺少百炼凭据（本门失败关闭，不会Skip或切换替身）");
}

// 必须先用仍存在的受管evidence回收上轮wrapper/child/socket，再删除可再生目录；
// 反过来会永久丢失Unix socket进程身份，Ctrl-C后的PTY child将无法安全识别。
if (workbenchOnly) {
  await cleanupDshRealWorkbench(repoRoot, { environment: process.env });
}
const browserTempMarker = join(dataRoot, "browser-temp-root.txt");
if (existsSync(browserTempMarker)) {
  const interruptedRoot = readFileSync(browserTempMarker, "utf8").trim();
  if (!managedDshE2eTemporaryRoot(interruptedRoot)) {
    throw new Error("Browser E2E中断恢复标记不是受管临时目录");
  }
  rmSync(interruptedRoot, { recursive: true, force: true });
}
const reservedPorts = promptStudioOnly
  ? Object.values(DSH_PROMPT_STUDIO_E2E_PORTS)
  : promptThreeGatesOnly
    ? Object.values(DSH_PROMPT_THREE_GATES_E2E_PORTS)
    : projectBootstrapOnly
      ? Object.values(DSH_PROJECT_BOOTSTRAP_E2E_PORTS)
      : capabilityGovernanceOnly
        ? Object.values(DSH_CAPABILITY_GOVERNANCE_E2E_PORTS)
        : planningFauxOnly
          ? Object.values(DSH_PLANNING_FAUX_E2E_PORTS)
          : Object.values(DSH_REAL_E2E_PORTS);
await assertE2ePortsFree(reservedPorts);
rmSync(dataRoot, { recursive: true, force: true });
mkdirSync(dataRoot, { recursive: true });
for (const directory of [resolve(dataRoot, "process-home"), resolve(dataRoot, "process-tmp")]) {
  mkdirSync(directory, { recursive: true });
}
if (projectBootstrapOnly || capabilityGovernanceOnly) {
  mkdirSync(join(dataRoot, "workspace-root"), { recursive: true });
}
const paidPromptTemporary = promptThreeGatesOnly
  ? resolve(repoRoot, ".data/e2e/dsh-t3-tmp")
  : undefined;
const deterministicBrowserTemporary = paidMode
  ? undefined
  : mkdtempSync(join(tmpdir(), "chat-dsh-e2e-"));
const activeTemporary = deterministicBrowserTemporary ?? paidPromptTemporary;
if (paidPromptTemporary !== undefined) {
  rmSync(paidPromptTemporary, { recursive: true, force: true });
  mkdirSync(paidPromptTemporary, { recursive: true });
}
if (deterministicBrowserTemporary !== undefined) {
  writeFileSync(browserTempMarker, `${deterministicBrowserTemporary}\n`, { mode: 0o600 });
}

const safeDshEnvironment = dshRealWebEnvironment(repoRoot, {
  ...process.env,
  CHAT_DSH_E2E_DATA_ROOT: dataRoot,
  ...(activeTemporary === undefined
    ? {}
    : {
        CHAT_DSH_E2E_TEMP_ROOT: activeTemporary,
        CHAT_DSH_E2E_TEMP_PARENT: dirname(activeTemporary),
        TMPDIR: activeTemporary,
        TMP: activeTemporary,
        TEMP: activeTemporary,
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

// Workbench只有beta-only模式才准备数百MB固定工件与Git fixture；Planning付费门也不得
// 顺带启动Workbench，否则会继续把两个完成门绑成一个不可分离的旧入口。
if (workbenchOnly) {
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
  (!workbenchOnly &&
    !pwaOnly &&
    !trajectoryOnly &&
    !promptStudioOnly &&
    !projectBootstrapOnly &&
    !planningFauxOnly) ||
  promptThreeGatesOnly ||
  capabilityGovernanceOnly ||
  planningFauxOnly
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
          : capabilityGovernanceOnly
            ? "[e2e-preflight] rc.6 Capability治理纵向已就绪（进程内Faux Provider；未加载真实凭据/Plane/Memory/Workbench）"
            : planningFauxOnly
              ? "[e2e-preflight] rc.6 Planning审核纵向已就绪（真实API/Product Store/Workflow/Pi AgentSession；进程内Faux Provider）"
              : promptThreeGatesOnly
                ? "[e2e-preflight] rc.6 DSH三闸门、真实Provider与Workflow Bundle已就绪（未启动Workbench/Memory）"
                : trajectoryOnly
                  ? "[e2e-preflight] rc.6 DSH profile与原生Trajectory/会话记录表面已就绪（使用测试Trace Provider，不加载Provider/Workflow/Workbench）"
                  : "[e2e-preflight] rc.6 DSH profile、真实Provider与Workflow Bundle已就绪（未启动Workbench/Memory）",
);

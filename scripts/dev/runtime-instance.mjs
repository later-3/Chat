import { isAbsolute, join, resolve } from "node:path";

export const RUNTIME_INSTANCE_NAMES = Object.freeze(["production", "debug"]);

export const PRODUCTION_RUNTIME_PORTS = Object.freeze({
  web: 43110,
  webInternal: 43114,
  api: 43111,
  workflow: 43112,
  piExecutor: 43115,
  workbenchLease: 43119,
  memory: 18960,
  memoryCore: 18970,
  apiInspector: 43120,
  workflowInspector: 43121,
  piExecutorInspector: 43122,
});

export const DEBUG_RUNTIME_PORTS = Object.freeze({
  web: 44110,
  webInternal: 44114,
  api: 44111,
  workflow: 44112,
  piExecutor: 44115,
  workbenchLease: 44119,
  memory: 19960,
  memoryCore: 19970,
  apiInspector: 44120,
  workflowInspector: 44121,
  piExecutorInspector: 44122,
});

function assertInstanceName(instance) {
  if (!RUNTIME_INSTANCE_NAMES.includes(instance)) {
    throw new Error(`--instance只支持 ${RUNTIME_INSTANCE_NAMES.join("、")}`);
  }
  return instance;
}

function configuredAbsolutePath(environment, name, fallback) {
  const configured = environment[name]?.trim();
  if (configured === undefined || configured === "") return fallback;
  if (!isAbsolute(configured)) throw new Error(`${name}必须是绝对路径`);
  return resolve(configured);
}

export function runtimePorts(instance = "production") {
  return assertInstanceName(instance) === "debug" ? DEBUG_RUNTIME_PORTS : PRODUCTION_RUNTIME_PORTS;
}

export function runtimePortList(instance = "production") {
  return Object.values(runtimePorts(instance));
}

/**
 * 一套运行实例必须同时拥有自己的端口、产品事实、Workflow状态、Runtime凭据、
 * DSH投影、Trace和进程登记。只换端口会让两个Runtime并发写同一事实，因此这里
 * 集中生成整套边界，调用方不能各自拼路径。
 */
export function resolveRuntimeInstance(root, instance = "production", environment = process.env) {
  const name = assertInstanceName(instance);
  const repoRoot = resolve(root);
  const ports = runtimePorts(name);
  const debug = name === "debug";
  const managedDataRoot = debug
    ? join(repoRoot, ".data", "instances", "vscode-debug")
    : join(repoRoot, ".data");
  const dataRoot = managedDataRoot;
  const pathFor = (environmentName, fallback) =>
    debug ? fallback : configuredAbsolutePath(environment, environmentName, fallback);
  const workflowBundleDir = pathFor(
    "CHAT_WORKFLOW_BUNDLE_DIR",
    debug
      ? join(repoRoot, "packages", "workflows", ".debug", ".workflow-bundle")
      : join(repoRoot, "packages", "workflows", ".workflow-bundle"),
  );
  const dshHome = pathFor("CHAT_DSH_HOME", join(dataRoot, "dsh-home"));
  const browserProfile = debug
    ? join(dataRoot, "browser-profile")
    : join(dataRoot, "debug", "browser-profile");
  const debugDir = debug ? join(dataRoot, "processes") : undefined;
  const environmentOverrides = {
    CHAT_RUNTIME_INSTANCE: name,
    CHAT_REPO_ROOT: repoRoot,
    CHAT_PUBLIC_WEB_PORT: String(ports.web),
    CHAT_DSH_INTERNAL_WEB_PORT: String(ports.webInternal),
    ...(debug
      ? {
          CHAT_PRODUCT_STORE_PATH: join(dataRoot, "product", "chat-product-store.v1.json"),
          CHAT_WORKFLOW_BUNDLE_DIR: workflowBundleDir,
          CHAT_WORKFLOW_DATA_DIR: join(dataRoot, "workflow"),
          CHAT_PI_EXECUTOR_DATA_DIR: join(dataRoot, "pi-executor"),
          CHAT_RUNTIME_BINDINGS_PATH: join(dataRoot, "runtime", "runtime-bindings.v1.json"),
          CHAT_RUNTIME_CREDENTIAL_PATH: join(dataRoot, "runtime", "runtime-key"),
          CHAT_TRACE_DIR: join(dataRoot, "traces"),
          CHAT_DSH_HOME: dshHome,
          CHAT_DSH_STATE_PATH: join(dataRoot, "dsh-lifeos-bridge", "state.json"),
          CHAT_API_BASE_URL: `http://127.0.0.1:${String(ports.api)}`,
          CHAT_WORKFLOW_BASE_URL: `http://127.0.0.1:${String(ports.workflow)}`,
          CHAT_API_INTERNAL_BASE_URL: `http://127.0.0.1:${String(ports.api)}`,
          CHAT_CODE_WORKBENCH_RUN_ROOT: join(dataRoot, "workbench", "code-server"),
          CHAT_DEBUG_DIR: debugDir,
          CHAT_DEBUG_PORTS: runtimePortList(name).join(","),
          // 调试实例始终是本机管理面；.env中的公网Host与认证文件不能把它重新
          // 接回production入口，也不能因load-env的非覆盖策略泄漏进来。
          CHAT_PUBLIC_WEB_HOSTNAME: "",
          CHAT_WEB_AUTH_REQUIRED: "0",
          CHAT_WEB_AUTH_CREDENTIALS_FILE: "",
          CHAT_WEB_AUTH_SESSION_SECRET_FILE: "",
        }
      : {}),
  };
  return Object.freeze({
    name,
    root: repoRoot,
    ports,
    portList: Object.freeze(runtimePortList(name)),
    dataRoot,
    workflowBundleDir,
    dshHome,
    browserProfile,
    debugDir,
    environment: Object.freeze(environmentOverrides),
  });
}

/** 安装器只覆盖Chat拥有的非秘密运行边界；Provider等私有配置仍由目标进程加载。 */
export function installRuntimeInstanceEnvironment(target, runtime) {
  Object.assign(target, runtime.environment);
}

export function parseRuntimeInstanceArgs(argv) {
  let instance = "production";
  for (const argument of argv) {
    if (!argument.startsWith("--instance=")) throw new Error(`未知参数：${argument}`);
    instance = assertInstanceName(argument.slice("--instance=".length));
  }
  return instance;
}

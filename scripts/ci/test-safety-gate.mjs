import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function enabled(value) {
  return value?.trim() === "1";
}

function requireSafeName(value, label) {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(value)) throw new Error(`${label}不是安全环境变量名`);
}

/**
 * 先验证命令身份与显式开关，再调用loadEnvironment读取.env或Key reader。
 * 这保证“本机恰好有Key”不会让普通命令触达凭据加载，更不会启动外部子进程。
 */
export async function validateTestSafetyGate(input, loadEnvironment) {
  const environment = { ...input.environment };
  if (input.mode === "paid") {
    if (!input.commandName.includes(":paid")) {
      throw new Error("付费测试命令名必须包含:paid");
    }
    if (!enabled(environment.CHAT_ALLOW_PAID_TESTS)) {
      throw new Error("付费测试需要显式设置CHAT_ALLOW_PAID_TESTS=1");
    }
    if (input.credentials.length === 0) throw new Error("付费测试必须声明精确Provider凭据");
  } else if (input.mode === "external") {
    if (!input.commandName.includes(":external:")) {
      throw new Error("外部测试命令名必须包含:external:");
    }
    if (!enabled(environment.CHAT_ALLOW_EXTERNAL_WRITES)) {
      throw new Error("外部写测试需要显式设置CHAT_ALLOW_EXTERNAL_WRITES=1");
    }
    for (const name of input.switches) {
      requireSafeName(name, "外部测试开关");
      if (!enabled(environment[name])) throw new Error(`外部测试需要显式设置${name}=1`);
    }
  } else {
    throw new Error(`未知测试安全门：${String(input.mode)}`);
  }

  const loaded = await loadEnvironment(environment);
  for (const name of input.credentials) {
    requireSafeName(name, "Provider凭据");
    if (typeof loaded[name] !== "string" || loaded[name].trim() === "") {
      throw new Error(`缺少精确测试凭据：${name}`);
    }
  }
  return {
    ...loaded,
    ...(input.mode === "paid" ? { CHAT_PAID_TEST_COMMAND_NAME: input.commandName } : {}),
    ...(input.mode === "external" ? { CHAT_EXTERNAL_TEST_COMMAND_NAME: input.commandName } : {}),
  };
}

export async function executeTestSafetyGate(input, dependencies) {
  const environment = await validateTestSafetyGate(input, dependencies.loadEnvironment);
  return dependencies.run(environment);
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  const separator = rest.indexOf("--");
  if (separator < 0) throw new Error("测试安全门缺少--后的子命令");
  const options = rest.slice(0, separator);
  const command = rest.slice(separator + 1);
  if (command.length === 0) throw new Error("测试安全门子命令为空");
  const values = (prefix) =>
    options
      .filter((option) => option.startsWith(prefix))
      .map((option) => option.slice(prefix.length));
  const commandNames = values("--command-name=");
  const loaders = values("--loader=");
  if (commandNames.length !== 1) throw new Error("测试安全门必须声明唯一--command-name");
  if (loaders.length > 1) throw new Error("测试安全门最多声明一个--loader");
  return {
    command,
    gate: {
      mode,
      commandName: commandNames[0],
      credentials: values("--credential="),
      switches: values("--switch="),
      environment: process.env,
    },
    loader: loaders[0] ?? "env",
  };
}

async function loadCliEnvironment(kind) {
  if (kind === "dashscope") await import("../debug/load-provider-env.mjs");
  else if (kind === "env") await import("../load-env.mjs");
  else throw new Error(`未知凭据加载器：${kind}`);
  return { ...process.env };
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    const status = await executeTestSafetyGate(parsed.gate, {
      loadEnvironment: async () => loadCliEnvironment(parsed.loader),
      run: (environment) => {
        const [command, ...args] = parsed.command;
        const result = spawnSync(command, args, { env: environment, stdio: "inherit" });
        if (result.error !== undefined) throw result.error;
        return result.status ?? 1;
      },
    });
    process.exitCode = status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

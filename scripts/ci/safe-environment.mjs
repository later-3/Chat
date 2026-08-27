export const PROVIDER_AND_CREDENTIAL_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "CHAT_DEBUG_PI_KEY_READER",
  "CHAT_DEBUG_PI_PROVIDER_CONFIG",
  "CHAT_MEMMY_TOKEN",
  "CHAT_PROJECT_MODEL_API_KEY_ENV",
  "CHAT_PROJECT_MODEL_BASE_URL",
  "CHAT_TENCENT_MEMORYCORE_TOKEN",
  "CHAT_WEB_AUTH_SESSION_SECRET_FILE",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "SSH_AUTH_SOCK",
]);

export const EXTERNAL_OPT_IN_ENV = Object.freeze([
  "CHAT_ALLOW_EXTERNAL_WRITES",
  "CHAT_ALLOW_PAID_TESTS",
  "CHAT_ALLOW_UNKNOWN_EXTERNAL_SERVICES",
  "CHAT_MEMORY_REAL_TEST",
]);

const DISABLED_FEATURE_ENV = Object.freeze({
  CHAT_ALLOW_EXTERNAL_WRITES: "0",
  CHAT_ALLOW_PAID_TESTS: "0",
  CHAT_ALLOW_UNKNOWN_EXTERNAL_SERVICES: "0",
  CHAT_CODE_WORKBENCH_ENABLED: "0",
  CHAT_EXTERNAL_TEST_COMMAND_NAME: "",
  CHAT_MEMORY_ENABLED: "0",
  CHAT_MEMORY_REAL_TEST: "0",
  CHAT_PAID_TEST_COMMAND_NAME: "",
});

function isEnabled(value) {
  return /^(?:1|on|true|yes)$/iu.test(value?.trim() ?? "");
}

/**
 * 普通CI只允许访问Git/npm等构建来源。真实Provider和外部写开关一旦被显式打开，
 * 核心门直接拒绝执行；仅存在Key时则把Key从所有子进程环境清空。
 */
export function createCiSafeEnvironment(input = process.env) {
  const enabled = EXTERNAL_OPT_IN_ENV.filter((name) => isEnabled(input[name]));
  if (enabled.length > 0) {
    throw new Error(`核心CI禁止启用真实Provider或外部写：${enabled.join(", ")}`);
  }

  // 动态Key名必须在配置变量被清空前读取；否则自定义Provider Key仍可能进入子进程。
  const dynamicProviderKey = input.CHAT_PROJECT_MODEL_API_KEY_ENV?.trim();
  const environment = { ...input, CI: "true", ...DISABLED_FEATURE_ENV };
  if (/^[A-Z_][A-Z0-9_]*$/u.test(dynamicProviderKey ?? "")) {
    environment[dynamicProviderKey] = "";
  }
  for (const name of PROVIDER_AND_CREDENTIAL_ENV) environment[name] = "";
  return environment;
}

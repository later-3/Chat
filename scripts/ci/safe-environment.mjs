export const PROVIDER_AND_CREDENTIAL_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "CHAT_DEBUG_PI_KEY_READER",
  "CHAT_DEBUG_PI_PROVIDER_CONFIG",
  "CHAT_MEMMY_TOKEN",
  "CHAT_PLANE_CE_API_TOKEN",
  "CHAT_PROJECT_MODEL_API_KEY_ENV",
  "CHAT_PROJECT_MODEL_BASE_URL",
  "CHAT_TENCENT_MEMORYCORE_TOKEN",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
]);

export const EXTERNAL_OPT_IN_ENV = Object.freeze([
  "CHAT_ALLOW_EXTERNAL_WRITES",
  "CHAT_ALLOW_PAID_TESTS",
  "CHAT_ALLOW_UNKNOWN_EXTERNAL_SERVICES",
  "CHAT_MEMORY_REAL_TEST",
  "CHAT_PLANE_CE_REAL_TEST",
]);

const DISABLED_FEATURE_ENV = Object.freeze({
  CHAT_ALLOW_EXTERNAL_WRITES: "0",
  CHAT_ALLOW_PAID_TESTS: "0",
  CHAT_ALLOW_UNKNOWN_EXTERNAL_SERVICES: "0",
  CHAT_CODE_WORKBENCH_ENABLED: "0",
  CHAT_MEMORY_ENABLED: "0",
  CHAT_MEMORY_REAL_TEST: "0",
  CHAT_PLANE_CE_REAL_TEST: "0",
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

  const environment = { ...input, CI: "true", ...DISABLED_FEATURE_ENV };
  for (const name of PROVIDER_AND_CREDENTIAL_ENV) environment[name] = "";
  return environment;
}

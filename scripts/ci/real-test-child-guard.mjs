function enabled(value) {
  return value?.trim() === "1";
}

function requireExactCommand(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}只能由精确受管命令${expected}启动`);
  }
}

/**
 * 真实测试入口自己的第二道授权门。父级launcher负责最小环境；入口仍必须在读取Key、
 * 删除/写入文件、启动子进程或发起网络请求之前精确核对命令身份与开关。
 */
export function assertRealTestChildAuthorization(input, environment = process.env) {
  if (input.mode === "paid") {
    if (!enabled(environment.CHAT_ALLOW_PAID_TESTS)) {
      throw new Error("真实Provider子入口需要CHAT_ALLOW_PAID_TESTS=1");
    }
    requireExactCommand(
      environment.CHAT_PAID_TEST_COMMAND_NAME,
      input.commandName,
      "真实Provider子入口",
    );
  } else if (input.mode === "external") {
    if (!enabled(environment.CHAT_ALLOW_EXTERNAL_WRITES)) {
      throw new Error("真实外部写子入口需要CHAT_ALLOW_EXTERNAL_WRITES=1");
    }
    requireExactCommand(
      environment.CHAT_EXTERNAL_TEST_COMMAND_NAME,
      input.commandName,
      "真实外部写子入口",
    );
    if (typeof input.serviceSwitch !== "string" || !enabled(environment[input.serviceSwitch])) {
      throw new Error(`真实外部写子入口需要${String(input.serviceSwitch)}=1`);
    }
  } else {
    throw new Error(`未知真实测试子入口模式：${String(input.mode)}`);
  }

  for (const credential of input.credentials ?? []) {
    if (typeof environment[credential] !== "string" || environment[credential].trim() === "") {
      throw new Error(`真实测试子入口缺少精确凭据：${credential}`);
    }
  }
}

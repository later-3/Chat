#!/usr/bin/env node
/**
 * 初始化 Chat Web 网关认证凭据（服务器部署模式）。
 *
 * 交互式读取账号与密码（不回显、不进 argv/日志），写入：
 *   .data/web-auth/credentials.json   v2 scrypt参数+口令散列（0600）
 *   .data/web-auth/session-secret     随机会话签名密钥（0600）
 * 两个文件只留在本机，绝不进入 Git（.data/ 已忽略）。重复运行会拒绝覆盖，
 * 除非显式传入 --rotate（轮换后既有会话 Cookie 全部失效）。既有单用户v1
 * 凭据会在下一次成功网页登录时用当次口令原子升级；本命令仍用于主动轮换账号。
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { hashWebAuthPassword, WEB_AUTH_CREDENTIAL_SCHEMA_VERSION } from "../dsh/web-auth.mjs";

const root = resolve(import.meta.dirname, "../..");
const rotate = process.argv.includes("--rotate");
const dir = join(root, ".data", "web-auth");
const credentialsFile = join(dir, "credentials.json");
const secretFile = join(dir, "session-secret");

if (!rotate && (existsSync(credentialsFile) || existsSync(secretFile))) {
  console.error(`[chat-auth] 凭据已存在：${dir}；轮换请显式使用 --rotate`);
  process.exit(1);
}

function question(prompt, { hidden }) {
  return new Promise((resolveQuestion, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden && rl.output.isTTY) {
      // 关闭回显：直接操作底层 TTY，避免密码进入终端回滚缓冲区。
      rl.stdoutMuted = true;
      const originalWrite = rl._writeToOutput;
      rl._writeToOutput = function mutedWrite(chunk, encoding, callback) {
        if (rl.stdoutMuted) {
          callback?.();
          return true;
        }
        return originalWrite.call(rl, chunk, encoding, callback);
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolveQuestion(answer);
    });
    rl.on("error", reject);
  });
}

const username = (await question("[chat-auth] 账号: ", { hidden: false })).trim();
if (!/^[a-zA-Z0-9_.-]{1,64}$/u.test(username)) {
  console.error("[chat-auth] 账号只允许字母数字与 _.-，最长 64 字符");
  process.exit(1);
}
const password = await question("[chat-auth] 密码: ", { hidden: true });
const confirm = await question("[chat-auth] 确认密码: ", { hidden: true });
if (password.length < 6) {
  console.error("[chat-auth] 密码至少 6 个字符");
  process.exit(1);
}
if (password.length < 12) {
  // 不阻断：这是单用户个人部署，口令强度由用户自行决定（2026-08-17 用户明确要求）。
  console.warn("[chat-auth] 警告：密码少于 12 个字符，强度较低");
}
if (password !== confirm) {
  console.error("[chat-auth] 两次输入的密码不一致");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
writeFileSync(
  credentialsFile,
  `${JSON.stringify(
    {
      schemaVersion: WEB_AUTH_CREDENTIAL_SCHEMA_VERSION,
      users: [{ username, scrypt: hashWebAuthPassword(password, salt) }],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
writeFileSync(secretFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
chmodSync(credentialsFile, 0o600);
chmodSync(secretFile, 0o600);
console.log(
  `[chat-auth] 已写入 ${dir}（0600）。`.concat(
    "在 .env 配置 CHAT_WEB_AUTH_REQUIRED=1 与两个文件路径后生效。",
  ),
);

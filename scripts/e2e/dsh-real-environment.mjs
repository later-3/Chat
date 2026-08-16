import { join, resolve } from "node:path";

import { dshWebEnvironment } from "../dsh/profile-runtime.mjs";

export function resolveDshRealDataRoot(root) {
  return resolve(root, ".data/e2e/dsh-real");
}

/**
 * E2E只改变受管DSH投影的位置，环境来源仍统一经过正式dshWebEnvironment白名单。
 * Workflow/API保留Provider配置；DSH Host及其插件只能看到基础工具链和桥接地址。
 */
export function dshRealWebEnvironment(root, environment = process.env) {
  const repoRoot = resolve(root);
  const dataRoot = resolveDshRealDataRoot(repoRoot);
  const dshHome = join(dataRoot, "dsh-home");
  const safe = dshWebEnvironment(repoRoot, {
    ...environment,
    CHAT_API_BASE_URL: "http://127.0.0.1:43111",
    CHAT_DSH_STATE_PATH: join(dataRoot, "bridge", "state.json"),
  });
  const hostHome = join(dshHome, "host-home");
  const temporary = join(dshHome, "tmp");
  return {
    ...safe,
    HOME: hostHome,
    USERPROFILE: hostHome,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(dshHome, "xdg-config"),
    XDG_CACHE_HOME: join(dshHome, "xdg-cache"),
    DSH_HOME: dshHome,
  };
}

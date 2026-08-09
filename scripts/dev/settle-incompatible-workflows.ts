import "../load-env.mjs";
import { resolve } from "node:path";
import {
  settleIncompatibleWorkflowRun,
  type ApplicationDeps,
} from "../../packages/application/src/index.js";
import { sha256Hex } from "../../packages/domain/src/index.js";
import { createTraceSink } from "../../packages/realtime/src/index.js";
import { settleIncompatibleLocalWorkflowRuns } from "../../packages/workflows/src/index.js";
import { createApplicationDeps } from "../../apps/api/src/composition.js";

/**
 * `pnpm dev/dev:debug`专用的跨版本恢复门。
 * 生产环境必须保留并路由到历史Workflow部署，不运行这个本地降级脚本。
 */

const root = resolve(process.env.CHAT_REPO_ROOT ?? resolve(import.meta.dirname, "../.."));
const bundleDir = resolve(
  process.env.CHAT_WORKFLOW_BUNDLE_DIR ?? `${root}/packages/workflows/.workflow-bundle`,
);
const workflowDataDir = resolve(process.env.CHAT_WORKFLOW_DATA_DIR ?? `${root}/.data/workflow`);
const bindingsPath = resolve(
  process.env.CHAT_RUNTIME_BINDINGS_PATH ?? `${root}/.data/runtime/runtime-bindings.v1.json`,
);
const productStorePath = resolve(
  process.env.CHAT_PRODUCT_STORE_PATH ?? `${root}/.data/product/chat-product-store.v1.json`,
);

const traceSink = createTraceSink();
const deps: ApplicationDeps = await createApplicationDeps(productStorePath, (event) => {
  traceSink.emit(event);
});
const settled = await settleIncompatibleLocalWorkflowRuns({
  bundleDir,
  workflowDataDir,
  bindingsPath,
  settleProductRun: async (productRunId) => {
    await settleIncompatibleWorkflowRun(deps, {
      commandId: `cmd_${sha256Hex(`dev-version-recovery:${productRunId}`).slice(0, 32)}` as never,
      productRunId,
      errorCode: "workflow.version_incompatible",
      summary: "本地代码版本已变化，旧后台运行无法安全恢复，已停止；请重新开始本次工作",
    });
  },
});

if (settled.length === 0) {
  console.log("[chat] Workflow版本恢复检查通过");
} else {
  console.log(`[chat] 已安全收敛${String(settled.length)}个旧版本Workflow Run`);
}

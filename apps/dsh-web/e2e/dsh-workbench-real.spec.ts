import { test } from "@playwright/test";
import {
  exerciseDshWorkbench,
  observeWorkbenchTraffic,
  openDshEmptyHero,
} from "./dsh-workbench-real-helper.js";

test("rc.6 DSH：空白Hero从全局Sidebar入口打开并保留隔离Code Workbench", async ({ page }) => {
  const traffic = observeWorkbenchTraffic(page);

  // 本配置不启动Workflow/API；保持blank Hero、只选择Chat workspace且全程不填充或
  // 提交composer，因此这条可重复完成门没有任何Provider/模型调用路径。
  await openDshEmptyHero(page);
  await exerciseDshWorkbench(page, traffic);
});

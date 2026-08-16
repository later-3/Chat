import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchSurfaceController } from "../src/client/workbench-controller.ts";

test("Workbench Surface开合可订阅且重复命令不制造额外状态", () => {
  const controller = new WorkbenchSurfaceController();
  const snapshots: boolean[] = [];
  const dispose = controller.subscribe(() => snapshots.push(controller.snapshot().open));

  assert.equal(controller.snapshot().open, false);
  controller.open();
  controller.open();
  controller.close();
  controller.close();
  dispose();
  controller.open();

  assert.deepEqual(snapshots, [true, false]);
});

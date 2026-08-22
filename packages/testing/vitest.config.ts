import { defineConfig } from "vitest/config";

/**
 * 真实Local World/真实HTTP服务/真实子进程的集成测试彼此竞争CPU与队列时，
 * 在负载高的机器上会集体超时（被测属性与时间无关，纯粹是资源竞争）。
 * 按Lessons #27物理隔离原则拆成两个project：
 * - unit：确定性单元/合同测试，保持并行；
 * - serial：真实Runtime集成测试与墙钟性能门，文件间串行（fileParallelism: false），
 *   同一时间只有一个真实World在跑。
 * 同一`vitest run`入口、CI门不变，只是重集成测试不再互相踩踏。
 */
const LOCAL_WORLD_FILES = [
  // s7容量门是墙钟性能预算，与重集成测试同组串行，避免并行负载下预算抖动。
  "src/s7-capacity-quality-gate.test.ts",
  "src/b2-backend-loop.test.ts",
  "src/m1-workflow-recovery.test.ts",
  "src/note-workflow-local-world.test.ts",
  "src/definition-kernel-lab-runtime.test.ts",
];

export default defineConfig({
  test: {
    globalSetup: ["../workflows/vitest.global-setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 120_000,
    // vitest projects不继承root级testTimeout/hookTimeout，必须在每个project内显式设置。
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: LOCAL_WORLD_FILES,
          testTimeout: 90_000,
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "serial",
          include: LOCAL_WORLD_FILES,
          fileParallelism: false,
          testTimeout: 300_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});

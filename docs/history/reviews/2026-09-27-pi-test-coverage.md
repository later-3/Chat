# Pi 原生测试分类与 Chat 对照验收

## 范围

Pi 固定源码 `0343d486d8d8c4622384fa18e93c7f1398cbd749`、0.85.1；Chat 工作区 `codex/unified-session-performance`，父提交 `fe296a63a1cf40f82e2cce425471840cbfeffa6a` 加已有改动。此次新增文档与索引，没有修改产品执行代码、Pi 源码或子模块 gitlink，没有提交、推送、部署。

交付为 [12 类机制、32 组场景对照](../../modules/pi/chat-pi-test-coverage.md)与 [468 个测试文件索引](../../modules/pi/pi-test-file-inventory.md)。按文件名全面收集，再用 TypeScript AST 读取 test/it 声明、嵌套 describe 和 each/skipIf 等标志；不展开动态参数/循环，也不据此计算执行数量或覆盖率。重点场景复核了测试体和实际断言，不能把全量索引表述成 468 个文件全部人工语义审查或全部执行。

结论保持三层：Pi 原生存在、Chat 实际接入、Chat 场景有回归证据。当前核心历史/自动压缩/工具循环仍在；产品入口缺口仍以 [49 项能力账本](../../modules/pi/chat-pi-session-capabilities.md)为准。本次补出的是更具体的失败与并发验收要求，没有把缺少测试一律判成已发生的运行错误。

## 本次实际执行

| 范围 | 结果 | 能证明什么 |
|---|---|---|
| 15 个选定原生文件 | **129 通过，0 失败，0 跳过**，Vitest 退出 0 | 该 Pi 源码的上下文、压缩、队列、重试、Session 生命周期及若干回归；不是 Chat HTTP/Runtime 验收 |
| 10 个 Chat 文件 | **73 通过，0 失败，0 跳过**，node:test 退出 0 | 公共工厂、业务 Workflow body、Friend 路由/生命周期、读模型、fork/name、Writer 和事件；不是重新运行真实 Nitro Runtime/浏览器 |
| 文档 | 架构检查、父仓库/Frontend 空白检查、新增文档本地链接与索引一致性检查通过 | 导航和清单可追溯 |

原生测试通过隔离 HOME/TMPDIR、去除继承的凭据环境、`PI_OFFLINE=1`、faux provider 执行。没有真实模型或收费调用；没有直接运行全量 vitest/npm test。Chat 用例使用各自的隔离目录和本地受控模型。

运行列表和报告在本机 `.data/verification/pi-test-audit/`：

- `inventory.json`、`titles.txt`：每文件/每静态声明的路径、行号、标题与条件标志。
- `native-test-selection.json`、`native-tests.json`、`native-tests.log`：准确选择与运行结果。
- `chat-tests.log`：Chat 73 项结果。
- `local-model-data-restore.json`：本地模型目录数据来源与校验。
- `native-tests-initial-setup-failure.*`：保留首次前置条件失败，未当作通过或业务缺陷。

### 原生执行列表

在 `pi/packages/coding-agent` 下，调用 `node ../../node_modules/vitest/dist/cli.js --run`，显式传入以下文件：

```text
test/session-manager/build-context.test.ts
test/agent-session-stats.test.ts
test/agent-session-auto-compaction-queue.test.ts
test/suite/agent-session-compaction.test.ts
test/suite/agent-session-queue.test.ts
test/suite/agent-session-retry-events.test.ts
test/suite/agent-session-prompt.test.ts
test/suite/agent-session-runtime.test.ts
test/suite/regressions/7048-compaction-truncated-summary.test.ts
test/suite/regressions/6647-compaction-retries-transient-stream-drop.test.ts
test/suite/regressions/8328-zero-usage-auto-compaction.test.ts
test/suite/regressions/6363-agent-settled-event.test.ts
test/suite/regressions/1717-2113-agent-session-event-settlement.test.ts
test/suite/regressions/pre-prompt-compaction-no-continue.test.ts
test/suite/regressions/8537-custom-message-tool-result-ordering.test.ts
```

前置条件：本地最初只有已构建的 Pi 模型数据，源码 `src/providers/data` 缺失；15 文件中 14 个在收集阶段报 `amazon-bedrock.json` 不存在，只有纯上下文文件的 16 项执行通过。尝试仓库 `pnpm pi:restore-model-data` 的公开发布归档下载未完成，已停止该任务启动的下载进程。随后从**当前本地已有的 dist 数据只读复制**到忽略的源码数据目录，使用 Pi 自己的 `validateGeneratedModelData` 对当前源码、manifest 结构和逐文件哈希验证通过（39 个数据文件），没有改 dist 或生成的 TS 模型源码，再执行上述 15 文件全部通过。数据 manifest SHA256：`132d4a9360277029063d1b267474cf67b625a57ccfea605f44f57f7f09dbf0a0`；不把此缓存说成刚下载的上游最新目录。

### Chat 执行命令

在 Chat 根目录：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types \
  --test-concurrency=1 --test --test-reporter=spec \
  test/agents/public-assembly.test.mjs \
  test/workflows/chat-session-workflows.test.mjs \
  test/workflows/session-memory-writer-runtime.test.mjs \
  test/session-read-model.test.mjs test/session-fork.test.mjs \
  test/session-name.test.mjs test/long-agents/turn-feedback.test.mjs \
  test/long-agents/daily-lifecycle.test.mjs \
  test/workflows/chat-run-events.test.mjs test/session-tree-projection.test.mjs
```

本次是文档审计，不重跑会改写运行中构建产物的 `pnpm verify`。前一轮 [982 项完整验证及实际 Runtime/浏览器证据](./2026-09-27-pi-session-capabilities.md)保持独立，不能合并成此次执行数量。

## 后续验收重点

优先补实际 Chat 链路中的摘要截断/断流/取消/溢出恢复、摘要请求预算准入、工具及扩展结束时序；接着补手动压缩/统计/队列/历史继续与扩展 UI 的 Backend 合同和入口。每项都要对应原生场景、Chat 改动边界和实际用户路径。终端显示、独立 Pi 协议与未采用的新 Session 后端单列，不记作需要照搬的基础功能缺失。

# 工程质量门与故障实验室

## 1. 命令分层

| 命令 | 目的 | 是否访问真实Provider |
|---|---|---|
| `./scripts/verify-fast.sh` | 格式、Lint、类型、编译、文档/密钥、后端与前端逻辑测试 | 否 |
| `./scripts/verify-fault-lab.sh` | 运行高风险并发、恢复、Cursor、Checkpoint与长场景矩阵，输出JUnit | 否 |
| `./scripts/verify.sh` | 覆盖率、迁移升降、生产构建、桌面/窄屏Playwright与可访问性 | 否 |
| `./scripts/verify-supply-chain.sh` | Python/npm漏洞与前端许可证策略 | 需要联网漏洞库 |

完整浏览器门使用独立FastAPI测试入口、临时SQLite和确定性Bootstrap Agent，不读取`backend/config.json`。

生产构建还会读取Vite manifest执行包体回归门：主入口不超过500 KiB，单个按需Feature不超过150 KiB，CSS不超过150 KiB，并且至少保留8个真实动态Feature入口。这里限制的是职责边界回退，不以Chunk数量代替真实加载性能。

## 2. CI合同

GitHub Actions固定Python 3.12、Node 22、`uv.lock`与`package-lock.json`，安装Chromium后运行完整门与供应链门。任何真实模型验证都必须是显式、受控、可观察的独立Job，不能让普通Pull Request意外产生计费。

## 3. 覆盖率不是唯一完成条件

后端总覆盖率门为70%；前端使用锁定的`c8`在Node 20.19+/22.12+统计编译后的源码，逻辑覆盖率分别设行45%、分支60%、函数55%。高风险状态仍必须由故障实验室逐项证明，不能用总百分比替代：

1. 并发唯一领取、Lease Epoch Fence和重复终态。
2. Checkpoint/HITL跨进程恢复和图版本不兼容。
3. Provider已发送后取消/超时的结果未知。
4. Cursor缺口、Hash冲突和断线重放。
5. Product Harness跨天、跨项目、来源失效与CAS。

## 4. 人工审核仍保留

自动门不能替代真实Provider精确Payload核对、长回复性能、键盘/读屏体验和用户对审批理解成本的审核。自动证据通过后，涉及这些边界的发布仍需明确的人工验证记录。

## 5. 当前验证快照

2026-07-23本地完整门通过：后端114项测试、76.34%总覆盖率；前端42项测试、行57.24%/分支67.53%/函数77.31%；12次迁移完整升降、10项故障实验以及桌面/Pixel 5共5项Playwright/axe检查通过。生产构建为450.2 KiB主入口和8个按需Feature；Python/npm漏洞与前端许可证门通过。远端GitHub Actions首次运行、真实多设备性能和人工键盘/读屏审核仍需单独证据。

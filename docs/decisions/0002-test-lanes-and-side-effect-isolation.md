# ADR-0002: 测试lane与付费/外部写隔离

- 状态：accepted
- 日期：2026-08-24
- 适用范围：根级测试入口、CI分层、真实Provider与外部服务门
- 决策所有者：Later / Chat

## 背景

单进程聚合全部测试曾在Node默认Heap下耗尽内存；同时名称含`real`的旧入口无法让调用方判断是否会
产生付费或外部写。仅靠本机是否存在Key不是授权。

## 决定

[`config/test-lanes.json`](../../config/test-lanes.json)唯一分类每个正式测试文件和根测试脚本为core、
contract、integration、compat、beta、browser、paid或external。确定性lane使用有界worker和独立进程；
`verify:core`统一去凭据。Browser复用唯一Playwright Harness；Workbench保持beta。

付费测试必须同时满足命令名含`:paid`、`CHAT_ALLOW_PAID_TESTS=1`和精确Provider凭据。真实外部写使用
各自独立开关。任一条件缺失时在加载Key或启动调用前失败，普通CI永不设置这些开关。

## 后果

默认Heap可以运行核心与全确定性测试，CI失败能定位到责任lane；付费与外部写不会因开发机Key存在而
意外触发。代价是完整确定性门以多个进程运行，compat、beta和browser按风险单独调度。

## 替代方案

- 全局设置8GB Heap：掩盖聚合内存问题，拒绝。
- 只按文件名约定分类：不可审计且易遗漏，拒绝。
- 用一个`ALLOW_REAL`开关：混淆付费与不同外部写授权，拒绝。

## 变更与回滚

新增测试必须先进入且只进入一个lane。若分类需要调整，先更新Manifest、命令与机器反例并比较计数和
资源报告；回滚恢复上一个完整分类，不能把测试移出所有lane。

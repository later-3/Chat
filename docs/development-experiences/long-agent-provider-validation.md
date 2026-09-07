# Long Agent 切换 Provider 的认证与工具合同

## 现象与根因

2026-09-07 微信来信已进入 Nexus，但 GLM 返回 429 ServerOverloaded。切换 Kimi 时发现两个独立缺陷：配置校验创建 ModelRuntime 时关闭 refresh，却立即读取认证快照，误报已配置 Provider 没有认证；随后 Kimi 返回 400，因为 workflow_call 的顶层 Union Schema 没有声明 type: object；只补 type 后又因根 anyOf 被拒绝。

## 为什么验证遗漏

既有配置测试没有成功保存具有认证的显式模型；本地假模型未检查每个工具的顶层参数类型。通道 ready 与静态注册通过都不能证明模型完成或消息投递。

## 修复与验证

配置校验执行 ModelRuntime 的离线初始化刷新，禁止网络模型发现，但加载本地认证状态。workflow_call 对外暴露普通对象参数（根部无 anyOf），执行前用原 action Union 严格验证必填字段及各分支。不要通过移除工具掩盖 Provider 参数合同错误。

回归门禁：long-agents.test.mjs 使用隔离 models.json 中的测试凭据保存显式模型；workflow-call-tool.test.mjs 检查真实工具 Schema 的对象根；完整 pnpm verify 覆盖 Builder、开发 Step bundle、生产构建与真实开发 Runtime。真实验收分别确认入站、模型结果、Delivery 和 Ack；429 需要等待恢复或经用户选择切换模型，不能当成通道失败。

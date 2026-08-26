# 全项目生命周期 K2 Product Store 实现事实

## 1. 已实现结果

Product Store 当前版本为 `chat-product-store.v23`。它在 v22 的 Capability Governance 与
Project Coordination 双谱系之上，新增并真实持久化七组工具无关的项目管理事实：

1. `projectProfileRevisions`：项目类型方法的不可变版本；
2. `projectConfigurationRevisions`：具体项目采用的目标、范围、参与者、资源和呈现绑定版本；
3. `projectEvents`：具有发生、观察、记录三种时间的统一历史；
4. `projectNeeds`：尚未等同于承诺的用户/资源需要；
5. `projectRequirements`：可验收的结果、行为、质量或约束；
6. `projectArtifactRefs`：正文仍在Resource中，Store保存locator、Revision、Hash和Provenance；
7. `projectMetricObservations`：有时间窗口、来源和Evidence的观察值。

这些集合不是某个外部事项字段、某个文档工具目录或DSH页面的数据副本。任何Presentation或
Resource Provider只能通过Configuration选择，不能改变上述对象身份。

## 2. 迁移与失败语义

`v22 → v23`只增加七组空集合，不扫描仓库、不推断Profile、不创建用户承诺，也不访问
Git或其他Provider。正式启动路径仍能识别：

- main的非空`v20 capability`谱系；
- P8的非空`v20 content`与`v21 coordination`谱系；
- 双谱系汇合后的`v22`。

所有路径最终进入v23完整性门，并使用原有同目录临时文件、fsync、atomic rename流程落盘。
未知Schema、Hash错误、悬空引用或迁移写入失败都会失败关闭，原文件保持不变；成功迁移后
再次打开不会改写字节。

## 3. 完整性与历史约束

Store在打开和每次事务提交前统一检查：

- Map key与对象ID一致；
- Profile key/version不重复，Profile与Configuration Hash可重算；
- 每个Project最多只有一个`adopted` Configuration；
- Configuration引用的Project、Profile、Participant、Resource和Decision同Project有效；
- Need/Requirement/Event/ArtifactRef/Metric的Project、Evidence和Provenance引用有效；
- Event已建模的Subject必须存在，且可选Revision必须与目标对象一致；
- Event与Metric Observation是追加式历史事实，提交后不能覆盖或删除；Profile、Configuration
  与Artifact Ref可以通过受治理的Revision/状态用例演进，不能由Router或Provider直接改写。

Need和Requirement仍是可演进业务对象；其变化必须由后续Application用例同步产生Event，不能
由Router或Provider直接修改。

## 4. 已验证范围

- Product Store包：122个测试通过；
- v22空迁移、首次落盘、重启逐字节幂等；
- 非空内置Profile真实提交并在重启后完整恢复；
- 原有v1-v22、Capability与Project Coordination迁移测试继续通过；
- 根级`pnpm typecheck`通过。

本页只证明K2的Store层已完成，不表示Application采用事务、六类Context、Maintenance、用户
View或四场景纵向已经完成。那些能力必须以各自as-built和纵向测试为准。

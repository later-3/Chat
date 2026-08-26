# 全项目生命周期 K2 Product Store 实现事实

## 1. 已实现结果

Product Store 当前写版本为 `chat-product-store.v24`。本页描述的K2项目事实仍由v23引入：
它在 v22 的 Capability Governance 与Project Coordination 双谱系之上，新增并真实持久化
七组工具无关的项目管理事实：

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

所有路径先无损进入v23，再通过`v23 → v24`只增加监督执行空集合；该迁移不扫描Pi Journal、
Workflow、Workspace或模型正文。最终快照进入v24完整性门，并使用原有同目录临时文件、fsync、
atomic rename流程落盘。
未知Schema、Hash错误、悬空引用或迁移写入失败都会失败关闭，原文件保持不变；成功迁移后
再次打开不会改写字节。

## 3. 完整性与历史约束

Store在打开和每次事务提交前统一检查：

- Map key与对象ID一致；
- Profile key/version不重复，Profile与Configuration Hash可重算；
- 每个Project最多只有一个`adopted` Configuration；只有adopted后继可声明`supersedes`，且链必须同Project、版本递增、单后继、无环；candidate和superseded不能伪造该关系；
- Configuration引用的Project、Profile、Participant、Resource和Decision同Project有效；Participant、Resource Binding、`capability + mode` Presentation Binding和required read在各自集合内唯一；
- Need/Requirement/Event/ArtifactRef/Metric的Project、Evidence和Provenance引用有效；
- Event对所有持久化Subject kind（包括Project本身）穷尽解析，拒绝任意ID和跨Project；没有持久聚合或外部Ref合同的kind显式拒绝；
- Event Subject的历史Revision不必等于当前对象Revision；同一对象的事件流按`beforeRevision → afterRevision`连续校验，拒绝断链或分叉，并要求最后一个afterRevision与当前对象对齐；
- Event与Metric Observation是追加式历史事实，提交后不能覆盖或删除；Profile、Configuration
  与Artifact Ref可以通过受治理的Revision/状态用例演进，不能由Router或Provider直接改写。

Need和Requirement仍是可演进业务对象；其变化必须由后续Application用例同步产生Event，不能
由Router或Provider直接修改。

## 4. 已验证范围

- Product Store相关确定性门通过；
- v22→v23与v23→v24空迁移、首次落盘、重启逐字节幂等；
- 非空内置Profile真实提交并在重启后完整恢复；
- 原有v1-v22、Capability与Project Coordination迁移测试继续通过；
- 相关包build、typecheck与test通过。

本页只证明K2的Store层已完成，不表示Application采用事务、六类Context、Maintenance、用户
View或四场景纵向已经完成。那些能力必须以各自as-built和纵向测试为准。

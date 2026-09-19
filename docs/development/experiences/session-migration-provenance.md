# Session 迁移保留原件与归属

P5 审计发现旧 Home 归一迁移在同名文件冲突时跳过目标文件，却仍删除源目录；重试还会覆盖首次备份。旧逻辑同时移动 JSONL、删除 Project 登记、将 Project Memory 提升到 Personal，导致旧 URL、历史归属和配置作用域可能丢失。这里记录代码可复现的缺陷，不推断用户曾丢失哪些数据。

直接根因是把“新的 Friend 专属空间”当成了所有旧 Project 事实的替代品。旧测试只断言归一后的目标结构，没有验证源文件字节、冲突两端、第二次执行或旧链接。仅看新会话正常无法证明迁移安全。

v2 保留原项目与原生记录，备份先原子发布且不覆盖；通过精确 Project＋Session 收据维护已迁移文件的旧链接。首次迁移不移动历史、不提升 Memory 作用域、不创建当天空会话。读取错误和冲突明确失败，完成标记只在全部步骤成功后落盘。历史 Friend 所有权必须同时约束读模型、Workflow 启动及改名，不能只禁用前端按钮。

共享每日 Session 不意味着渠道地址相同：绑定选择必须校验 Nano 来源、Group 与目的地，不能仅按 chatSessionId 取第一个。配置拆分与 schema 升级另保留首次备份和中断恢复标记，不引入第二套消息存储。

自动化门禁：`test/long-agents/migration.test.mjs` 的原件哈希、冲突重试、v1 链接、schema1 历史、跨日只读、非法 JSON/符号链接、定义并发与完成标记恢复；`test/long-agents/long-agents.test.mjs` 的同 Session 不同渠道。副本演练和真实浏览器补充验证读取与恢复，不能把模拟渠道当真实外部收发。

经验资源 `session-migration-provenance` 进入现有 Prompt 资源库供选择，不自动给所有 Agent 注入。操作步骤只在[迁移手册](../../operations/friend-migration.md)维护。

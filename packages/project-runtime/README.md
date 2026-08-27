# @chat/project-runtime

受权 Workspace、Git 与项目文档的只读观察适配器。

本包不拥有 Project 产品账本、用户授权或 Workflow 编排；Application 决定资源访问权，Product Store 保存权威事实。

## 边界

- 上游是 Application Project Port；下游是受限根目录与本地 Git。
- Adapter 只做资源识别、读取、校验与失败归一，不直接写 Product Store。
- 普通测试只访问临时目录，不触达用户 Workspace。

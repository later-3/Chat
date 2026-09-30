# 配置存在不等于 Agent 能使用

## 现象与影响

2026-09-30 检视 Long Agent、Workflow 和模型设置时，Agent Memory 能列出文件且工具已激活，助手仍不能可靠更新已有记忆；模型支持图片的配置存在，却未在选用模型时显示。设置页还存在长名称越界、保存后检查陈旧、切换目标期间旧检查残留。

## 已验证根因

- `agent_memory_read` 的 revision 只在 Pi `details`，模型只收到正文；CAS 写入缺少必要输入。旧测试仅验证新建，没有从读取结果更新已有文件。
- Pi 使用替换 System Prompt 时跳过默认 promptGuidelines。只补指南仍不能覆盖实际使用自定义身份的助手；方法必须在实际工具 description/Schema 中可见。
- Nano 原生记忆说明包含原生容器路径，Chat 的窄 Resource API 并不开放该路径；旧身份文本又可能把已上线工具说成未上线。
- 配置保存、解析检查和实时服务健康没有分开；“检查成功”不能证明网关当前可达，也不能证明草稿已生效。
- 迁移来的模型页面保留未接入 API 的按钮，授权目录请求又吞掉错误；配置字段存在不能证明操作已实现。Backend 必须下发可用操作，缺失时按不可用处理。
- 共用弹窗里面残留旧尺寸/first-child 布局覆盖，子导航宽度失效。源代码结构断言未验证实际布局。

## 正确实现与验证

沿用户场景核对配置事实、授权、装配、模型实际输入、执行回执和页面反馈。Memory 结果的正文与 revision 同时进入模型 content；用真实 Pi + 本地假模型完成 list→read→update，并在 stale revision 时拒绝覆盖。none/explicit 作用域仍是权限事实，能力说明不能补发工具。

平台能力以本轮 Tool 合同为准，身份职责仍来自用户配置。旧身份、历史和容器路径不能覆盖当前执行环境；不要自动改写用户 Markdown 或复制不同领域的 Memory。

HTTP 模型投影与表单保存必须保留原生 Pi 字段；图片与规格来自同一目录。页面只用一个 SurfaceDialog，导航与详情有独立宽度边界。检查区说明项目范围、保存后重新读取，旧请求不得覆盖新目标。服务失败要明确显示，不能把缺失目录说成“无能力”。

假模型处理函数中的断言不能只转成 HTTP 500：Pi 可能将它记录成终态错误而让 prompt 正常返回。测试框架必须收集并上抛处理函数错误，并断言最终 assistant 为正常 stop 和预期回复，避免请求数/写入计数正确却把失败收尾当作成功。

## 自动化门禁

- `test/agents/public-assembly.test.mjs`：真实 Pi 发送实际 tool description/result，经窄 HTTP Memory 完成现有文件更新与冲突拒绝；限制工具场景无权限扩张。
- `test/long-agents/agent-group-service.test.mjs`：模型可见目录/正文/版本、主机绑定 Group、审计和大小限制。
- `test/models-config.test.mjs`、Frontend 配置/目录解析测试：图片、baseUrl、samplingParams 与 compat 保存并经 Pi 解析；拒绝无效结构。
- `scripts/configuration-browser.test.mjs`：真实构建页面的保存回读、非法 JSON、长模型名和 1440/768/390 视口；回归在 `pnpm test:built` 执行。

这些门禁使用隔离 CHAT_HOME 和本地假模型，不代表任何真实供应商或正式 Nano Host 的在线写入验收。正式配置抽查只读，原文不进入仓库。


## 后续视觉与完成提示回归（2026-09-30）

首轮检查覆盖表单保存，却没有限制关闭 `details` 的实际高度。Friend / Workflow 复用统一折叠原语，浏览器门禁现在断言关闭行不超过 60px（标准行 52px）、模型与思考选择不溢出，并验证从 Agent 打开全局模型编辑器时草稿不丢失。不能用“已经复用弹窗”和源码选择器存在，代替真实页面密度验收。

运行列表条目消失只表示需要重读，不能表示成功。完成提示按整个执行 ID 去重，需检查持久终态；真实双 Agent 浏览器测试覆盖中间 Agent 完成不响、整轮完成一次，纯合同测试覆盖失败/取消与前后台重复观察。

## 原生 SDK 与生产资产位置（2026-09-30）

完整历史改用 Pi 原生 SDK 后，源码测试成功而生产 HTTP 返回 500：Nitro 将 SDK 合并进服务目录，Pi 默认按包位置查找的 HTML 模板/主题文件不在原位置。只增加依赖 trace 也不能解决受管源码链接被 Nitro 按根目录内模块打包的情况。

原生模板、vendor JS 和主题 JSON 随构建作为显式资源携带；每次冷导出物化到私有临时目录，经 Pi `templateDir`/`themeFile` 参数读取，结束后清理。保留同一渲染器，不修改全局包目录或主题状态。门禁为 Pi 的 `sdk-session-export`（资源迁址、两种导出入口与分支完整性）、Built Server 的实际 HTML API 和开发浏览器首次可读/重试/取消。

# 主题模式完整会话收口

日期：2026-09-25。范围：基于已有未提交实现完成纠偏方案 M1–M3 的用户链，不新增 Agent Runtime、执行队列或审核系统。未提交、未推送、未部署正式服务。

## 实际改动

1. **创建可在原对话审核和恢复**：现有 Session/Run 绑定记录可信来源与请求摘要；只读创建列表联结 Run、审核与产物。日常对话、主题导航共用同一审核组件。新建/fork/旧 integrations 新请求统一到审核 Workflow，历史 work 重放仍可读取。重复启动复用 Run，冲突拒绝。
2. **会话真实可用**：新节点身份接入公共 ChatWindow；公共 Session read 可恢复节点执行引用。work/remember 同一轮次、真实阶段反馈，刷新/重连后仍能停止；停止直接在窄屏输入工具栏可见。记忆回执折叠到过程，最终显示工作答案。
3. **输入能力一致**：composer 能力由公共 Agent/Model Resolver 返回，保留已有冻结轮次能力审计；图片选择经公共图片合同到节点接受与模型 HTTP 请求，再从原生消息恢复。
4. **页面以聊天为中心**：桌面填满可用宽高，消息独立滚动、输入锚底；窄屏主题导航按需打开；来源/记忆/锚点/补充整合在公共资料弹层，不抢聊天高度。审核弹窗挂页面层，不随导航折叠而被裁掉。
5. **直接链接不会跳走**：主题等全局视图暂停 SessionSidebar 的默认 Friend 选择；首次打开 `?view=topics&topicAgent=…&topicId=…&nodeId=…` 保持目标页面。浏览器回归不再用随后点击导航掩盖首屏跳转。

## 用户动作与证据

| 场景 | 验收证据 |
|---|---|
| 日常发起 → 两轮修改 → 审核刷新/重连 → 批准 → 进入唯一节点；取消不创建 | `scripts/topics-browser.test.mjs` 实际指针/键盘 + 服务端 Run/图断言；`scripts/topic-create-workflow.test.mjs` 真 Runtime、旧版本批准拒绝与批准版本落库 |
| 普通节点对话/工具/第二轮上下文，追加仍在同一节点 | 公共 ChatWindow 浏览器链 + `topic-integration.test.mjs` 运行中第二条与 steer 冻结目标回归 |
| 工作答案已出现、remember 仍在运行 → 断线/刷新 → 停止 | 浏览器 hold writer 模型响应，读取真实阶段，点击可见停止；断言同 turn cancelled、无 completed 锚点，不再次 POST 正文 |
| 结束后主要回答仍可见 | 浏览器 writer 回答故意与工作答案不同；`message-display.test.mjs` 断言最终答案选择；公共读取重置旧阶段标签 |
| 图片选择、传输、持久化、恢复 | 浏览器真实文件输入 + 能力开启的假模型 HTTP `image_url` + 原生消息图片断言 |
| 从父锚点审核后 fork → 子会话续聊 → 刷新 | 浏览器点击、审核、节点与冻结父边、子节点消息断言 |
| 记忆 CAS 冲突保留编辑、开关、memory/relay 补充 | 浏览器操作 + 服务端事实；原有双 relay 唯一原生消息/同分支锚点回归保留 |
| 桌面/窄屏布局与缩放 | 390×844、768×1024、1440×900；150%/200% 等效 CSS 视口与像素密度，截图、可见尺寸、指针命中及焦点 |

图片项证明产品传输与恢复合同，未把假模型称为真实视觉识别质量测试。缩放使用 Chrome 的视口与密度模拟，未声称人工操作缩放菜单。跨进程执行中恢复保持既有 interrupted/不自动重放语义。

## 最终验证记录

修正直接链接后的最终 `pnpm verify` **exit=0**：**56 tooling / 639 Backend / 192 Frontend / 30 built / 10 dev**，共 927 项通过，含类型检查、Frontend/Backend/CLI 生产构建、真实 Workflow Runtime 与完整浏览器链。日志：`/tmp/topic-closeout-verify-final.log`。扩展浏览器定向复跑也通过（1/1）。

`pnpm check:architecture` exit=0（148 entrypoints）；父仓库和 Frontend 的 `git diff --check` 均 exit=0。代码与文档均保留未提交状态。

真实模型复核：2026-09-25 18:09–18:11（Asia/Shanghai），`command / deepseek/deepseek-v4.1-flash`、thinking high，隔离 Nitro dev + 真 Workflow Runtime。4/4 场景通过：

- 自然语言日常轮次实际选择 `request_topic`，批准前主题数为 0。
- 修改后 revision 2，拒绝旧版批准，批准当前版产生唯一根节点“订单页空指针”。
- 节点轮次 completed，会话中 assistant 文本共 1684 字符，浏览器中工作回答正常显示；记忆阶段完成后有 settled 锚点。
- 用真实锚点经同一审核 Workflow 产生唯一子节点与父边（anchorSequence=1）。

浏览器的两轮修订/取消/运行中停止是确定性模型证据；真实模型故事修改一轮，不混称同一条端到端。预览模型的 capabilities 返回 `images:false`，界面明确禁用图片；支持图片的输入/传输链已在本地假模型浏览器回归中验证，不宣称完成真实视觉质量评测。

测试准备阶段曾直接调用库执行播种日常消息，模型过早尝试建题，因该脚本尚未注册创建启动器而被拒；来源历史保留该失败。正式四个故事场景均在启动 Nitro 后通过真实 HTTP 入口执行，不把播种调用当作已成功建题证据。

## 留给用户的预览

[进入真实模型创建的根节点](http://127.0.0.1:63375/?view=topics&topicAgent=friend&topicId=topic-8277afb14b601a20abfdfade2479906b&nodeId=node-7c444d55570bcbf8ef7a9e6313c1ea78)。已有一组根/子节点和真实回答，可继续对话、查看资料、审核新建或分叉。

这是本机隔离预览，正式 43110 服务未替换。进程及隔离数据目录记录在 `.data/verification/topic-mode/closeout-preview.json`；预览停止后地址失效。结束预览可向记录中的父进程发送 SIGTERM，它会关闭自己的 Nitro 并清理自己的临时 CHAT_HOME/构建目录；不终止其他 Chat 进程。

浏览器截图与原始模型证据在 gitignored `.data/verification/topic-mode/`；测试临时数据使用隔离 CHAT_HOME。真实模型仅通过符号链接复用现有模型配置，不复制或输出认证内容。

经验归档：[主题会话接入公共聊天的验收接缝](../../development/experiences/topic-session-public-chat-closeout.md)。

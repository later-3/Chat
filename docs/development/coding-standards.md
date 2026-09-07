# Chat 编码规范

本文适用于 Chat 父仓库的 Backend、Workflow和公共 TypeScript 代码。Frontend 同时遵守[Frontend 开发指南](../../frontend/docs/development.md)，Pi 修改遵守`pi/AGENTS.md`；模块专用规则优先补充到对应模块文档，不在本文复制。

## TypeScript

- 保持严格类型。先定义真实数据边界，不使用`any`、宽泛断言或忽略错误来绕过设计问题。
- 网络、文件和 Session 中读取的数据都是`unknown`，必须在边界做运行时校验。
- 公共类型只表达调用方需要的合同；不要把内部运行对象直接暴露给 Frontend 或持久化格式。
- 优先使用清晰的小接口和联合类型表达状态，不用抽象隐藏简单分支。

## 模块与依赖

Chat 的主依赖方向是：

```text
Frontend -> Backend API -> Workflow -> Agent装配 -> Pi公开接口
```

- 模块只拥有自己领域的状态和持久化。Frontend 不拥有服务端事实，Workflow 不实现第二套 Agent Runtime。
- 共同行为进入现有公共入口；不要为一个 Workflow、页面或路由复制 Session、资源、Tool 或 Agent 装配逻辑。
- 依赖应指向稳定公开接口。修改 Pi 的通用能力时改`pi/`源码和测试，不修改生成的`dist`文件。
- 新模块先确认 owner、输入、输出、持久化位置和失败方式；没有独立职责时不要增加新子系统。

## API与错误

- HTTP 路由只接受明确字段，拒绝未知或非法输入，并返回可供用户采取行动的安全错误。
- Frontend 与 Backend 同时维护运行时合同；不能只更新 TypeScript 类型或只让页面适配偶然响应。
- 不吞掉持久化、权限、路径、Provider 或 Workflow 错误。添加上下文时保留原始原因，但不要向浏览器泄露 Credential、Cookie、Token 或内部堆栈。
- 异步状态要区分运行中、等待、完成、失败、取消和未知；不要把网络失败解释成 Agent 已失败。

## 路径与持久化

- 用户级数据只能从统一的 Chat Home 和 ProjectContext 派生，不能用`process.cwd()`猜测配置或用户数据目录。
- 所有用户提供或持久化的路径必须规范化并通过授权边界检查；跨 Project 访问必须显式指定目标。
- 运行数据写入采用原子替换、锁或明确冲突保护。迁移必须可恢复、可重试，并保存迁移标记。
- 不在源码仓库写入 Session、Memory 数据库、运行日志或 Credential。临时测试使用隔离目录并负责清理。

## 命名与注释

- 沿用稳定术语：Project、Session、Workflow、Node、Stage、Agent、Skill、Tool、Rule、Experience。
- 名称描述事实和职责；避免`manager`、`helper`、`data`等无法说明 owner 的宽泛命名。
- 注释解释目的、边界、非显然原因和失败语义，不复述代码。过时注释与错误注释按缺陷处理。
- 用户错误信息说明失败对象、原因和下一步；日志包含诊断身份，但不得记录秘密或完整敏感请求。

## 安全与变更

- 不提交正式 API Key、OAuth 凭证、Cookie、模型密钥、真实用户数据或私有部署配置。
- 不增加隐式外部写入、付费调用或跨 Project 权限。需要新授权边界时先更新设计和用户界面。
- 保留工作区已有修改，不使用破坏性的 Git 清理命令，不批量暂存无关文件。
- 改变配置格式、持久化位置、公共 API 或 Session 语义时，必须同时说明兼容性和迁移方式。

## 完成修改

先运行与改动最接近的检查，再按[测试指南](../testing.md)完成所需集成验证。父仓库交付前通常执行：

```bash
pnpm verify
git diff --check
git -C frontend diff --check
```

测试通过不能代替架构核对。若修改跨越 Project、Workflow、Agent装配、Session 或 Frontend/Backend 边界，还要从[架构索引](../architecture/README.md)选择相关文档复核。

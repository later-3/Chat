# 本地运行时升级掩盖部署 Node.js 语法不兼容

## 现象与影响

2026-09-04，部署与 Submodule 改造在 macOS 上通过完整 `pnpm verify`，但使用固定 Node.js 22.19.0 的 GitHub CI 在 Backend 测试装载 Workflow 源码时失败。11 个测试共同报错：

```text
SyntaxError: Unexpected identifier 'decisionHook'
```

错误位置是两个人工审核 Workflow 中的 `using decisionHook = ...`。同一代码在本地 Node.js 24.8.0 可以直接解析，因此本地全绿没有证明 Linux 部署使用的固定运行时也兼容。

## 直接根因

Chat 的 CI 和 Linux 部署明确固定 Node.js 22.19.0，但开发机使用 Node.js 24.8.0。`using` 显式资源管理声明可被后者解析，前者在当前源码装载链中不能解析。TypeScript 类型检查、Nitro 构建和 Node.js 24 测试都没有替代 Node.js 22 的真实语法门禁。

Workflow Hook 同时公开幂等的 `dispose()` 与 `[Symbol.dispose]()`。因此问题不需要升级生产运行时或改变 Hook 架构；用 `const` 创建 Hook，并以覆盖完整审核轮次的 `try/finally` 调用 `decisionHook.dispose()`，即可保留冲突检查、等待审核、批准返回、计划修订和异常路径的原释放语义。

## 为什么原验证没有发现

1. 本地 `pnpm verify` 继承了开发机 Node.js 24，没有使用部署固定版本。
2. 原 CI 长期先在更早的 Pi 模型准备阶段失败，从未执行到 Chat Backend 源码装载。
3. 类型检查验证类型和目标配置，不保证运行源码的 Node.js 版本能够解析所有新语法。

## 正确姿势

1. CI、自动部署和文档必须共享同一 Node.js 固定版本；升级版本需要独立评审和完整验证。
2. 本地较新运行时通过不能替代固定生产运行时。涉及新 JavaScript/TypeScript 语法时，要检查实际由 Node.js 直接装载的源码边界。
3. 资源释放优先使用依赖公开的 `dispose()` 与普通 `try/finally`，除非部署基线已经验证支持声明级显式资源管理语法。
4. `finally` 必须覆盖完整审核轮次，确保冲突、发布、记录、修订、批准返回和异常都释放 Hook；不能只在正常路径末尾调用。
5. 网络、Submodule、依赖安装和应用测试应作为独立 CI 阶段观察，避免前置故障长期遮蔽后续运行时兼容问题。

## 自动化门禁

- `scripts/deployment-config.test.mjs` 检查两个审核 Workflow 不再出现声明级 `using`/`await using`，并保留 `finally { decisionHook.dispose(); }`。
- GitHub CI 固定 Node.js 22.19.0 并运行完整 `pnpm verify`，直接验证 Backend 源码装载、Workflow Builder、生产构建和真实开发 Runtime。
- `pnpm test:dev` 继续覆盖计划修订、批准和执行链，验证手工释放没有改变 Workflow 语义。

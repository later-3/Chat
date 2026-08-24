# ADR-0001: Managed Fork与三仓版本锁

- 状态：accepted
- 日期：2026-08-24
- 适用范围：Chat、Pi Fork、DSH Fork的安装、构建与运行来源
- 决策所有者：Later / Chat

## 背景

Chat运行时直接链接Pi与DSH受管Fork的源码。依赖相邻个人checkout、浮动分支或已构建但来源不明的
工件，会让干净Runner无法复现，也会让错误Fork静默进入运行时。

## 决定

[`config/managed-sources.json`](../../config/managed-sources.json)是三仓精确来源锁：固定origin、branch、
commit、包管理器、锁文件、构建命令、能力marker、许可证和4条Chat source link。安装命令只从该
Manifest准备和验证来源；来源、HEAD、dirty、marker、license或link任一漂移都失败关闭。

Chat不重新引入Pi/DSH package patch，不修改受管稳定分支，也不把Fork源码复制进Chat。

## 后果

干净Runner可只凭Chat与公开固定源完成安装构建；升级必须同时审查Fork能力证据、Manifest与合同测试。
代价是首次准备需要下载和构建固定工件，且Fork不可用时Chat拒绝退回官方包。

## 替代方案

- 浮动跟随Fork分支：无法复现，拒绝。
- 依赖本机相邻checkout：CI和新Agent不可接手，拒绝。
- 恢复下游patch：掩盖Fork来源并形成双重维护，拒绝。

## 变更与回滚

升级时先在独立Fork分支验证，再更新唯一Manifest和Chat合同。回滚恢复上一个已验证三仓commit组合并
重跑Managed Sources、核心门和Browser门；不得只回滚Chat而保留不匹配Fork。

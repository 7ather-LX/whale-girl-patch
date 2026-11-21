# v1.0.6 · 适配鲸鲸 4.1.7.1

> 适配 **鲸鲸 4.1.7.1**。这是兼容性更新。

## 更新

- 基础软件升级到 4.1.7.1 后，聊天补丁的钩子仍兼容：
  - `Store.buildContext`
  - `Gateway.handleInbound`
  - `routes.createRouter`
  - `app.createRuntime`
  - `links.describeLink`
- 启动器换成 4.1.7.1 的三栏版：
  - **补丁 / 图片 / 生理**；
  - 多文件、框架依赖构建，Defender 扫描无威胁。
- 安装器的基础版本提示改为 4.1.7.1。

## 安装

1. 先装鲸鲸 4.1.7.1；
2. 下载 ZIP 解压，双击 `install.cmd`；
3. 完全退出鲸鲸再打开；
4. 左侧「补丁」栏 / 私聊测试跨聊天指令。

## 说明

`data/`、`config.json`、共享记忆配置和聊天记录都不会被安装器覆盖。

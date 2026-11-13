# v1.0.1 · 适配鲸鲸 4.1.0（更新后恢复补丁）

> [!IMPORTANT]
> **这是补丁，不是独立软件，单独下载不能运行。**
> 必须先安装 **鲸鲸 / Whale Girl**：<https://github.com/Banan1cee/whale_girl>
> 当前适配：**4.1.0**；旧版 4.0.8.2 请用 `v1.0.0` 的启动器构建。

## 这个版本解决什么

鲸鲸从 **4.0.8.2 更新到 4.1.0** 后，官方安装器会覆盖：

- `server.js` 第一行的补丁挂钩；
- `WhaleLauncher.exe`（带「补丁」栏的版本会被官方 4.1.0 启动器替换）。

表现就是：**「补丁」栏消失、链接阅读和跨聊天记忆失效**。

v1.0.1 做了两件事：

1. 启动器「补丁」页适配 **4.1.0**（基于上游 `main` 4.1.0 源码重新编译）；
2. 安装器继续自动检测本体版本，只装匹配的启动器，不会把 4.0.8.2 的启动器硬装到 4.1.0 上。

补丁功能本身不变：跨聊天记忆共享、B 站/网页/小黑盒链接阅读、视频画面、安全策略。

## 更新后恢复（3 步）

1. **下载并解压** 本 Release 的 `whale-girl-patch-v1.0.1.zip`；
   - 解压到一个固定目录，例如 `D:\WhaleGirlPatch`，以后更新都用它；
   - 里面能看到 `install.cmd`。
2. **双击 `install.cmd`**：
   - 自动找鲸鲸目录；找不到会弹窗，选包含 `server.js` 的文件夹；
   - 看到 `6/6` 和 `Installed successfully`；
   - 会重新加 `server.js` 挂钩，并把启动器换成 4.1.0 带「补丁」栏的版本（备份原文件）。
3. **完全退出启动器**（托盘右键 → 退出）再打开：
   - 左侧最后一项「补丁」回来了；
   - 或在浏览器打开 <http://127.0.0.1:8787/patch/>。

> 只点启动器里的「重启」不够：那只重启内核，不会加载新的启动器文件。

## 如果「补丁」栏还是没有

按顺序检查：

1. `install.cmd` 的输出里 `6/6` 是 `launcher tab installed` 还是 `skipped`？
   - `skipped` 通常表示本体版本和 `launcher/version.txt` 不一致；
   - 本版本 `launcher/version.txt` 是 `4.1.0`，本体也必须是 4.1.0。
2. 看鲸鲸目录里有没有：
   - `whale-patch\` 目录；
   - `server.js` 第一行 `require('./whale-patch').install();`；
   - `WhaleLauncher.exe.whale-patch.bak`（安装器备份）。
3. 确认启动器是**完全退出**后重开的，不是只点「重启」。
4. 运行自检：
   ```powershell
   "D:\WhaleGirl\runtime\node.exe" "D:\WhaleGirl\whale-patch\cli.js" doctor
   ```
   看「启动挂钩」是否 ✅。
5. 实在不行先用网页控制台 `http://127.0.0.1:8787/patch/`，功能完全一样。

## 使用说明

打开启动器 **「补丁」** 或 <http://127.0.0.1:8787/patch/>：

- **跨聊天记忆**：点「把所有群聊放进一组」→ 群聊互通（推荐，不碰私聊）；
  或新建共享组，逐个个勾选群聊 / 私聊，选择摘要 + 原话 / 只看摘要 / 只看原话；
- **链接阅读**：总开关控制是否读群友链接；「视频画面」控制是否看 B 站封面/故事板；
- **试读一个链接**：填 URL 点「读取」，确认模型能看到内容；
- 保存后下一轮聊天生效，不用重启。

## 以后本体再更新

- 鲸鲸每次更新都可能覆盖挂钩和启动器；
- 处理办法始终是：**重新运行 `install.cmd`**；
- 如果补丁还没发布对应新版本的启动器构建，安装器会只装服务端补丁，网页控制台仍可用；
- 关注本仓库 Release：<https://github.com/7ather-LX/whale-girl-patch/releases>

## 许可

基于鲸鲸 / Whale Girl（作者 [@Banan1cee](https://github.com/Banan1cee)，<https://github.com/Banan1cee/whale_girl>）修改，
遵循 **AGPL-3.0-only**。分发或通过网络提供修改版时，请保留 `LICENSE`、`NOTICE.md` 并提供完整对应源码。

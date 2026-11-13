# 版本与更新策略

鲸鲸本体更新很频繁，补丁不能假设「装一次管一辈子」。这个仓库按下面的规则发布。

## 1. 版本号

- 补丁版本：`1.x.y`（`patch/version.js` 和 Git tag）。
- 兼容的本体版本写在 `launcher/version.txt` 和 Release 说明里。
- 当前：补丁 **1.0.1**，适配本体 **4.1.0**（4.0.8.2 的启动器构建见 tag `v1.0.0`）。

## 2. 用户怎么更新

### 本体更新后

1. 正常更新鲸鲸（启动器 / 安装包）；
2. 更新可能会覆盖 `server.js`（去掉补丁挂钩）和 `WhaleLauncher.exe`（去掉「补丁」页）；
3. **重新运行一次 `install.cmd`**：
   - 补丁会重新加挂钩、恢复「补丁」页（如果当前本体版本有对应启动器构建）；
   - `data\whale-patch.json`、聊天记忆、补丁配置都会保留。

### 补丁更新

1. 下载新 Release 的 ZIP；
2. 解压，双击 `install.cmd`（会自动找到鲸鲸目录）；
3. 启动器「停止 → 启动」。

安装器是幂等的：重复运行只更新文件，不会重复加挂钩。

### 网页控制台始终可用

即使「补丁」页因为本体版本不匹配没有安装，补丁服务仍会提供：

```text
http://127.0.0.1:8787/patch/
```

功能和启动器里的页面完全一样。

## 3. 维护者发布流程

每次鲸鲸发布新版本后：

1. 拉取对应源码分支（例如 `release/4.0.8.x`），确认 `package.json` 版本；
2. 应用 `launcher/launcher.patch`：
   ```powershell
   git clone --branch <对应分支> https://github.com/Banan1cee/whale_girl.git whale_girl
   cd whale_girl
   git apply ..\whale-girl-patch\launcher\launcher.patch
   ```
3. 把 `launcher/WhaleLauncher.csproj` 的 `<Version>` 改成新本体版本；
4. 编译：
   ```powershell
   dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher\publish `
     -p:PublishSingleFile=true -p:SelfContained=false -p:IncludeNativeLibrariesForSelfExtract=true
   ```
5. 把产物复制到本仓库 `launcher/WhaleLauncher.exe`，更新 `launcher/version.txt`；
6. 在**该版本本体**上跑：
   - `install.cmd`
   - 启动器「补丁」页能打开、能改共享组 / 链接开关
   - 微信收发、B 站链接、共享记忆预览
7. 更新 `patch/version.js`、`package.json`、`CHANGELOG.md`、Release 说明；
8. 生成 ZIP 并发布：
   ```powershell
   git archive --format=zip --output="..\whale-girl-patch-v1.x.y.zip" v1.x.y
   ```
9. Release 说明里写清楚：
   - 适配的本体版本；
   - 启动器「补丁」页是否包含；
   - 迁移注意事项。

## 4. 为什么不自动更新启动器

- 鲸鲸启动器是官方签名/更新的，自动替换会干扰官方更新；
- 补丁只在**版本完全匹配**时替换启动器，并保留 `WhaleLauncher.exe.whale-patch.bak`；
- 卸载会还原备份；
- 本体更新后，如果补丁还没发布对应启动器，**不硬装旧版启动器**，避免把本体降级或改坏。

## 5. 兼容性矩阵

| 补丁 | 本体 | 启动器「补丁」页 | 服务端补丁 |
| --- | --- | --- | --- |
| 1.0.1 | 4.1.0 | ✅ | ✅ |
| 1.0.1 | 4.0.8.2 | ✅（用 1.0.0 的启动器构建） | ✅ |
| 1.0.1 | 4.1.x 未来小版本 | 需要重新构建启动器 | 通常可用，先跑 doctor |

> 新版本适配后在这里加一行，并在 Release 里注明。

## 6. 为什么不做成 4.1 的「社区插件」

鲸鲸 4.1 的插件市场目前面向 **WebAssembly 工具 / 人设包**：插件在沙箱里跑，
通过 `whale.*` 接口读输入、写输出，不能改记忆管线、不能替换 `links.describeLink`，
也不能给启动器加导航页。

本补丁需要的是：

- 改写 `Store.buildContext` 的返回值（跨聊天记忆）；
- 替换 `links.describeLink`（B 站接口 / 无头浏览器 / 看图）；
- 一个能读写这些配置的页面。

所以它仍然是**服务端外挂 + 可选启动器页**，而不是插件市场里的一个 wasm。
如果以后官方开放「记忆 / 链接 / 启动器页面」级别的插件接口，再把 UI 和逻辑迁过去，
迁移成本主要在配置格式，不会丢用户数据。

## 7. 文件都装在哪

全部在鲸鲸安装目录内，不写系统目录、不写注册表（除启动器备份）：

```text
鲸鲸目录\
  whale-patch\                 补丁代码
  data\whale-patch.json        补丁配置
  data\whale-patch\            浏览器临时目录 / 视频帧缓存
  server.js                    第一行多一句 require('./whale-patch').install();
  server.js.whale-patch.bak    原 server.js 备份
  WhaleLauncher.exe            带「补丁」页的启动器（可选）
  WhaleLauncher.exe.whale-patch.bak  原启动器备份
```

卸载会删掉 `whale-patch\`、挂钩，并还原启动器；`data\whale-patch.json` 默认保留。


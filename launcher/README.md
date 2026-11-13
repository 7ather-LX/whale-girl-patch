# 启动器「补丁」页（可选组件）

这个目录里是给鲸鲸启动器加一栏「补丁」的成品：

- `WhaleLauncher.exe`：编译好的启动器（基于上游 **4.0.8.2**）；
- `launcher.patch`：相对上游源码的全部改动（新增补丁页 + 导航项 + WebView2 依赖）；
- `version.txt`：这份二进制对应的本体版本，安装器据此决定装不装。

> 上游源码：<https://github.com/Banan1cee/whale_girl>，分支 `release/4.0.8.x`，
> 对应 commit `bdd39e3c22db759aa0c99938ffc60acc9cc44c76`。

## 它是什么

- 在启动器左侧导航最后加一栏 **「补丁」**；
- 页面用 WebView2 嵌入补丁自带的 `/patch/` 管理页（和浏览器里看到的一样）；
- 顶部有「在浏览器打开」「刷新」；连不上补丁服务时显示原因并每 4 秒自动重试；
- 只允许 WebView2 访问本机补丁页，不允许导航到外部网站。

## 为什么不直接改鲸鲸源码

补丁的稳定形态是 **服务端外挂**：`whale-patch/` + `server.js` 第一行挂钩。
这样鲸鲸升级时，业务源码不被改，补丁可以单独更新。

启动器是编译好的 WPF 程序，加一栏必须重新编译。为了不把「补丁」变成「另一个鲸鲸」：

- 这个启动器是**可选项**，安装器只在**本体版本正好是 4.0.8.2** 时才装；
- 装之前备份原 `WhaleLauncher.exe`；
- 卸载时还原；
- 本体升级到新版本后，这一栏会失效（官方启动器会覆盖它），重跑 `install.cmd` 即可：
  如果补丁仓库还没有对应新版本的启动器构建，安装器会跳过启动器、只装补丁，网页控制台仍然可用。

## 重新编译

需要 .NET 10 SDK、Windows。

```powershell
git clone --branch release/4.0.8.x https://github.com/Banan1cee/whale_girl.git whale_girl
cd whale_girl
git apply "C:\path\to\whale-girl-patch\launcher\launcher.patch"

# 可选：更新版本号（必须和本体一致，否则安装器不会装）
# launcher/WhaleLauncher.csproj 里 <Version> 改成目标版本

dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher\publish `
  -p:PublishSingleFile=true -p:SelfContained=false -p:IncludeNativeLibrariesForSelfExtract=true
```

产物是 `launcher\publish\WhaleLauncher.exe`，复制到本目录并更新 `version.txt`。

依赖：`Microsoft.Web.WebView2`（NuGet 自动还原）。运行时需要系统有 WebView2 Runtime；
Win10/11 一般自带，缺失时页面会提示改用浏览器打开。

## 许可

启动器源码来自鲸鲸（AGPL-3.0-only），本目录的二进制与 patch 同样遵循 AGPL-3.0-only。
分发时请保留仓库根目录的 `LICENSE` / `NOTICE.md`，并提供对应源码（本 patch + 上游源码）。

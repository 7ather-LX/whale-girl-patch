# NOTICE · 署名、许可与第三方组件

本文件是 [LICENSE](LICENSE) 的补充说明。若与 LICENSE 冲突，以 LICENSE 的法律条款为准。

## 1. 项目来源与署名

- 上游项目：**鲸鲸 / Whale Girl**
- 上游作者与指定署名方：**[@Banan1cee](https://github.com/Banan1cee)**
- 上游地址：<https://github.com/Banan1cee/whale_girl>
- 本仓库：**鲸鲸补丁 / whale-girl-patch**（上游的修改版补丁）
- 许可：**GNU Affero General Public License v3.0 only（AGPL-3.0-only）**

本仓库不是鲸鲸官方发行版，而是第三方补丁。按 AGPL-3.0 与上游 NOTICE 的要求，在任何分发、镜像、
应用内致谢或网络服务中，请保留 `LICENSE`、本 `NOTICE.md`，并注明：

> 基于鲸鲸 / Whale Girl（作者 @Banan1cee，https://github.com/Banan1cee/whale_girl）修改。

## 2. 本补丁做了哪些修改

**没有修改**鲸鲸原有服务端业务源码（`src/` 下的文件保持上游原样）。安装器只做了两件事：

1. 把 `patch/` 复制为鲸鲸目录下的 `whale-patch/`；
2. 在 `server.js` 顶部加一行 `require('./whale-patch').install();`。

另外，**可选的启动器「补丁」页**修改了上游启动器源码（`launcher/`）：新增一个导航项和一个
WebView2 页面。改动以 `launcher/launcher.patch` 形式提供，当前基于上游 `main` 4.1.0
（commit `8d541f430622054f84b27c7b349f11a7afeb2a8e`），成品为 `launcher/WhaleLauncher.exe`。
不安装这个可选组件时，启动器完全保持上游原样。

补丁在运行时新增：

- 跨聊天记忆共享（共享组、只读拼装、token 预算、隐私开关）；
- 链接阅读增强（B 站公开接口、无头 Edge/Chrome 渲染、正文/评论抽取、视频故事板看图）；
- 链接安全策略（内网拦截、端口/协议限制、域名黑白名单、DNS 钉扎）；
- 本机管理页 `/patch/` 与 `/api/patch/*`、命令行工具 `whale-patch/cli.js`。

补丁自身代码以 AGPL-3.0-only 发布。分发修改版、或让用户通过网络使用修改版时，
必须按 AGPL-3.0 提供完整对应的源代码。

## 3. 角色与图标

本仓库**不包含**鲸鲸的图标、角色形象、表情包素材。管理页只使用 emoji 🐋 作为占位，
不涉及上游角色版权。鲸鲸原角色的版权归 **上善无形** 所有，详见上游 `NOTICE.md`。

## 4. 第三方组件

| 组件 | 位置 / 使用方式 | 许可与说明 |
| --- | --- | --- |
| 鲸鲸 / Whale Girl | 运行时依赖 | AGPL-3.0-only；上游作者 @Banan1cee |
| 鲸鲸启动器（修改版） | `launcher/WhaleLauncher.exe` | 基于上游 `release/4.0.8.x` 源码修改，AGPL-3.0-only；源码改动见 `launcher/launcher.patch` |
| Microsoft WebView2 | 启动器「补丁」页 | Microsoft 许可；NuGet `Microsoft.Web.WebView2`，运行时由系统 Edge WebView2 Runtime 提供 |
| Microsoft Edge / Google Chrome | 由用户系统提供，补丁只调用其无头模式 | 各自许可；补丁不打包、不分发浏览器 |
| Pillow (PIL) | 鲸鲸安装包自带的 `runtime/python` 内 | HPND / PIL Software License；只用于裁视频故事板 |
| Bilibili 公开接口 | 运行时访问 `api.bilibili.com` | 接口归哔哩哔哩所有；补丁只读取公开信息，不绕过登录 |
| 小黑盒 / 微博 / 知乎等网页 | 运行时访问目标站点 | 内容版权归原站点与作者；补丁只在本地读取 |

补丁不包含任何第三方 npm 包，全部使用 Node.js 内置模块。

## 5. 联系

- 上游问题：<https://github.com/Banan1cee/whale_girl/issues>
- 本补丁问题：请在本仓库开 Issue，并**不要**贴 API Key、聊天记录或其他敏感信息。

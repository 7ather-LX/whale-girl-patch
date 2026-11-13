# 插件市场适配评估（为什么现在还上不了架）

结论：**当前插件市场没有能承载本补丁的插件类型。**
不是投稿流程的问题，而是宿主扩展点不够。按官方 `AGENTS.md` 的规则，这种情况应停在插件草稿、
列出缺少的扩展点，不能通过安装脚本、替换 EXE、加载 DLL 或修改宿主源码绕过。

## 1. 市场实际支持的类型

| 类型 | 能做什么 | 与本补丁的关系 |
| --- | --- | --- |
| Api 1 / Api 2 工具 | 用户输入文字，Wasm 计算/返回文字；Api 2 可再声明 `chat.summary` | 不能联网、不能读记忆、不能读链接 |
| Api 3 消息插件 | 7 个消息环节；`chat.history` 最近 12 条**当前会话**；`model.prompt` 改系统提示词 | 不能跨会话、不能联网、不能加页面 |
| 人设预设 | 纯数据提示词 | 与记忆/链接无关 |

官方明确：

- 插件不得修改鲸鲸程序文件、替换 EXE、加载任意 DLL、运行安装脚本；
- 插件不得自行往左侧工作台、状态栏、系统设置或托盘加入口；
- 目前不开放定时器、任意文件、直接联网、自定义模型服务调用、跨会话主动发送；
- 缺少接口时应停止上架并说明缺口。

## 2. 本补丁需要但当前没有的扩展点

### A. 跨聊天记忆读取

需要（建议命名）：

```text
memory.shared.read
  输入：当前 chatId、用户授权的 scope（一组 chatId）、查询文本、预算 token
  输出：其它聊天的摘要、相关原话（带来源标签/时间）
  授权：用户在插件卡片里按共享组确认；可随时撤销
  限制：只读；不返回密钥、文件、未授权会话
```

当前 `chat.history` 只能读**当前会话最近 12 条**，`state` 又是按插件+会话隔离，
无法实现「A 群说过的事 B 群能接上」。

### B. 链接读取

```text
link.fetch
  输入：公网 http(s) URL
  输出：标题、正文片段、评论、图片（可选）
  限制：宿主执行内网/端口/域名白名单检查；用户可关闭；带缓存和超时
```

当前 Wasm 没有网络权限，Api 3 也没有 `link.fetch` 之类的 HostAction；
所以「点开群友的 B 站/小黑盒链接」无法在插件里实现。

### C. 配置页面

```text
plugin.settings.page
  允许插件在「插件市场 → 已安装 → 设置」里渲染一个简单页面：
  群/私聊勾选、共享组、链接开关、试读输入框
```

当前插件设置只能是作者提供的 JSON 配置键值，做不了聊天选择器和试读按钮。
如果不想开放任意 UI，也可以由宿主提供通用的“会话多选 + 开关”控件供插件声明使用。

### D. 可选：视觉

如果希望插件也能“看”B 站封面/画面，需要宿主提供：

```text
vision.describe
  输入：图片 URL 或受限的二进制
  输出：文字描述
```

没有的话，插件只能做纯文本链接读取。

## 3. 如果扩展点开放，插件形态

- ID：`whale-girl-memory-links`
- Kind：`message`
- Api：3
- Hooks：`chat.prompt`（注入共享记忆/链接内容）、`chat.reply`（可选）
- Permissions：`memory.shared.read`、`link.fetch`、`plugin.settings.page`
- 设置：共享组、聊天多选、链接开关、域名黑白名单、视频画面开关
- 所有逻辑在 Wasm 内；不写宿主文件、不改 EXE、不跑安装脚本。

## 4. 现阶段建议

1. 本补丁继续以「服务端外挂 + 可选启动器页」发布（当前 v1.0.2）；
2. 把本文作为扩展点申请材料，向 `Banan1cee/whale_girl` 提交 Issue / 讨论；
3. 等宿主实现 A–C（D 可选）后，再按市场 `AGENTS.md` 制作独立插件、走
   `Banan1cee/whale-girl-plugins:main` 的 PR；
4. 在此之前**不要**用“安装脚本/替换 EXE”的方式伪装成插件——这会被市场拒绝，也会破坏用户环境。

## 5. 参考

- 插件市场 README：<https://github.com/Banan1cee/whale-girl-plugins>
- 投稿规范：<https://github.com/Banan1cee/whale-girl-plugins/blob/main/AGENTS.md>
- 插件作者入门：<https://github.com/Banan1cee/whale_girl/blob/main/docs/插件作者入门.md>
- Api 3 协议：<https://github.com/Banan1cee/whale_girl/blob/main/docs/插件消息流程Api3.md>

# 设计说明

> 这份文档写给想改补丁 / 提 PR 的人。只想知道怎么用，看 [README](../README.md) 就够了。

## 1. 约束

1. **不改鲸鲸业务源码**。鲸鲸是 AGPL 项目、安装器会校验文件，直接改 `src/pipeline/chat.js` 既难升级也难卸载。
2. **零 npm 依赖**。鲸鲸安装包不带 `node_modules`，补丁不能要求用户重新 `npm install`。
3. **补丁出错不能影响聊天**。每个包装点都自己 `try/catch`；失败时退回鲸鲸原逻辑。
4. **记忆默认隔离**。跨聊天共享必须显式开启、显式选聊天，且只读。

## 2. 启动链路

```text
WhaleLauncher
  └─ runtime\node.exe server.js
       ├─ require('./whale-patch').install()      ← 安装器只加这一行
       │    ├─ config.ensure(root)                → data/whale-patch.json
       │    ├─ patchStore(root)                    → 包 Store.prototype.buildContext
       │    ├─ patchLinks(root)                    → 包 links.describeLink / formatForPrompt
       │    ├─ registerRoutes(root)                → 包 createRouter
       │    └─ patchRuntime(root)                  → 包 createRuntime
       └─ 原 server.js：createRuntime / createRouter / listen
```

`app.createRuntime` 被包装后，补丁拿到 `runtime` 引用（logger / config / store），
用于日志、看图配置、管理页状态。`createRuntime` 包装必须在 `server.js` 解构它之前完成，
所以安装器把那行放在 `server.js` 第一行。

## 3. 跨聊天记忆

### 3.1 为什么只读

另一种做法是「把 A 群的消息镜像写进共享池会话」，但会有：

- 同一条消息落两份盘、摘要算两遍（费 token、费磁盘）；
- 清空 A 群时共享池里还留着一份，用户以为删干净了；
- 共享池的 `chatId` 会出现在 `data/memory/chats/` 里，迁移 / 备份 / 导出都要特殊处理。

所以补丁选择**每次生成上下文时，从组内其它聊天读摘要和原话**。代价是每轮多扫几百条消息（内存里，微秒级），
换来的是「退出共享 = 立即干净」。

### 3.2 注入点

`Bot.decide` 调 `store.buildContext(...)` 拿到 `mem`，随后：

```js
const memoryBlock = [mem.block, mem.relationsBlock].filter(Boolean).join('\n\n');
const turns = this.buildTurns(msg, history, memoryBlock, tail);
```

补丁把共享块追加到 `mem.block` 末尾：

```text
【人物卡 / 事件 / 摘要】          ← 原版
（这些只来自当前这个聊天…）          ← 原版声明，补丁替换成共享语境
【跨聊天记忆 · 共享组「X」】       ← 补丁
  · 群「A」最近在聊：…
  · [群「A」·11-12] 小明：…
（这是你自己的记忆…）               ← 补丁
```

注意：**替换声明**是必要的。原版声明说「别提别的聊天」，直接追加共享块会让模型收到自相矛盾的指令。
`shared.patchScopeNotice()` 用上游导出的 `MEMORY_SCOPE_NOTICE` 精确替换，上游改文案时补丁会退化为「保留原声明 + 共享块」，
不会崩。

### 3.3 预算

- 共享块默认 320 token（`sharedMemory.maxTokens`），从 80 到 1200 可调；
- 超预算时**整段整段丢**：先丢人物偏好，再丢最近原话，头和尾声明永远保留；
- 它只占最后一条 user 消息，不打断 system 前缀缓存。

硬上限仍是鲸鲸的 64,000 token；共享块最多 1200，不会成为硬上限失败的主因。

### 3.4 隐私

- 组内聊天由用户在管理页显式勾选；`chats: ["*"]` 是显式选择「全部」；
- `match: "group"` / `"private"` 是「按类型自动」：只读该类型的聊天，新建的也自动加入。
  这是推荐用法——群聊之间互通不碰私聊；私聊组默认停用，需要用户手动打开；
- `sharePeople` 默认关；打开后只共享**同一个 uid** 的偏好，不做姓名猜测；
- 文件传输助手（`filehelper`）永远跳过；
- 管理页在「群聊 + 私聊混组」时显示红色提示：私聊内容可能出现在群里。

## 4. 链接阅读

```text
links.describeLink(url)
  └─ reader.describe
       ├─ policy.checkUrl        协议 / 端口 / 账号密码 / 内网 / 黑白名单
       ├─ bilibili.describe      B 站公开接口 + 故事板裁帧
       ├─ http.text              普通网页
       ├─ extract.parse          title / og / article / comments
       ├─ browser.render         空壳 SPA → Edge/Chrome --dump-dom
       └─ enrichVision           封面 / 画面 → 看图模型
```

### 4.1 安全

- `policy.checkUrl` 先做同步检查；`policy.resolveHost` 再做 DNS 检查。
- 请求时把解析出的 IP **钉**在 `lookup` 上，避免「检查时公网、连接时内网」的 DNS rebinding。
- 多个解析地址按系统顺序尝试（见 `http.js` 的 `attempt`）：有些 CDN 的 IPv4 节点会黑洞，
  死磕第一个地址会误判「读不到」。
- 浏览器只对 `browserDomains` 里的站点启动；每次全新 profile，跑完删除。
- 管理页 `/patch/` 不是 `/api/`，额外加了 loopback 检查。

### 4.2 B 站

- `x/web-interface/view`：标题 / 简介 / UP 主 / 时长 / 播放点赞投币收藏 / cid。
- `x/tag/archive/tags`：标签。
- `x/v2/reply?sort=2`：按热度排序的评论。
- `x/player/videoshot`：官方故事板（默认 10×10 张 160×90）。补丁下载拼图，
  用内置 Python + Pillow 裁 3 张，交给看图模型。
- 不读字幕、不下载完整视频。需要登录/大会员的内容会失败，回退到网页解析。

### 4.3 小黑盒

分享页是 SPA，直接抓 HTML 只有空壳。补丁：

1. 先解析 URL 里的 `redirect_data`（分享卡片自带标题/简介）做兜底；
2. 判断「空壳」后调用无头 Edge/Chrome；
3. `--dump-dom` 输出重定向到临时文件（不用管道，避开 Windows 沙箱/杀软的 EPERM）；
4. `extract.htmlToText` 按 `image-text__content` 标记切正文，`全部评论` 之后切评论。

### 4.4 缓存

- 成功结果缓存 `cacheMinutes`（默认 60 分钟）；
- 失败只缓存 5 分钟，避免一次网络抖动让链接一小时都打不开；
- 缓存是进程内 Map，重启清空；管理页可手动清。

## 5. 失败模式

| 情况 | 行为 |
| --- | --- |
| 补丁配置坏了 | 按默认值运行，管理页顶部红字提示 |
| 共享块生成异常 | 记一次 warn，本轮只用原版记忆 |
| 链接读取异常 | 退回原版 `links.describeLink` |
| 无头浏览器缺失 | 只读静态 HTML / B 站接口，prompt 里说明「没看画面」 |
| 看图模型没配 | 跳过视觉，不报错 |
| 站点返回人机验证 / 反爬页 | 识别为 `blocked`，明确说「没读到」，绝不把验证码页当正文喂模型 |
| 管理页注册失败 | 记 warn，聊天照常 |
| 任何包装点安装失败 | `server.js` 继续启动，鲸鲸按原样运行 |

## 6. 测试

- 单元测试：配置归一化、安全策略、HTML 抽取、共享块预算、B 站解析。
- 集成探针：临时复制一份鲸鲸，启动服务器，调 `/api/patch/*`、`bot.handle`、真实链接。
- 真实数据探针：复制真实 `data/memory`，验证真实群/私聊的摘要、人物卡、标题标签。
- 手工：`cli.js doctor`、管理页截图、`test-link` 小黑盒 / B 站 / 内网地址。

测试不联网的部分可以离线跑；B 站 / 小黑盒探针需要网络。

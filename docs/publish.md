# 发布到 GitHub

仓库已经初始化好（`main` 分支 + `v1.0.0` tag），只差一个远程地址和你的 GitHub 登录。

## 1. 在 GitHub 上新建空仓库

打开 <https://github.com/new>：

- Repository name：`whale-girl-patch`（或你喜欢的名字）
- 可见性：**Public**（AGPL 补丁建议公开；Private 也可以，但 AGPL 要求向使用者提供源码）
- **不要**勾选 “Add a README / .gitignore / license”（本地已经有了）

创建后复制仓库地址，例如：

```text
https://github.com/<你的用户名>/whale-girl-patch.git
```

## 2. 推送

在仓库目录（本文件上一级）打开 PowerShell：

```powershell
git remote add origin https://github.com/<你的用户名>/whale-girl-patch.git
git push -u origin main --tags
```

第一次推送会弹出 GitHub 登录（浏览器授权），按提示登录即可。
如果机器上没有 `git`，可以用 GitHub Desktop：Add local repository → 选择本目录 → Publish repository。

## 3. 建议补充的仓库信息

- **About**：`鲸鲸 / Whale Girl 补丁：跨聊天记忆共享 + B站/小黑盒链接与视频阅读`
- **Topics**：`whale-girl` `wechat-bot` `llm` `memory` `bilibili` `xiaoheihe` `agpl`
- **Releases**：用 tag `v1.0.0` 建一个 Release，附上 `whale-girl-patch-v1.0.0.zip`
  （由 `git archive` 生成，不含 `.git` 和测试数据）。

## 4. 发布前检查

```powershell
git status                 # 应该只有你主动改的文件
git log --oneline -3
git tag -n
```

- 不要提交 `data/`、`config.json`、API Key、聊天记录；`.gitignore` 已经忽略 `data/` 和 `*.log`。
- 截图 `docs/patch-ui.png` 里不要出现真实聊天内容 / 路径；当前截图是测试数据。
- 保持 `LICENSE`、`NOTICE.md` 原样；AGPL 要求分发修改版时提供完整源码。

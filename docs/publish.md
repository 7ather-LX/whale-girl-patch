# 发布到 GitHub

仓库已经初始化好（`main` 分支 + `v1.0.0` tag），只差一个远程地址和你的 GitHub 凭据。

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

> 浏览器里登录 GitHub **不等于** git 有推送权限。HTTPS 弹密码时要填
> **Personal Access Token（至少 repo 权限）**；或者把 `~/.ssh/id_ed25519.pub`
> 加到 GitHub → Settings → SSH keys，再把 remote 换成
> `git@github.com:<用户名>/whale-girl-patch.git`。
> 也可以直接用 GitHub Desktop：Add local repository → 选择本目录 → Publish repository。

## 3. 仓库信息（很重要，别让人误以为这是独立软件）

**About** 填：

```text
鲸鲸 / Whale Girl 的外挂补丁：跨聊天记忆共享 + B站/小黑盒链接与视频阅读，装好后启动器多一栏「补丁」。必须先安装基础软件 https://github.com/Banan1cee/whale_girl
```

**Topics**：`whale-girl` `wechat-bot` `llm` `memory` `bilibili` `xiaoheihe` `agpl`

README 首屏已经用 `> [!IMPORTANT]` 写明：

> 这不是独立软件，单独下载没有作用；必须先安装鲸鲸 4.0.x（附基础软件地址）。

## 4. 建 Release（安装包）

推送 tag 后，仓库里的 GitHub Actions（`.github/workflows/release.yml`）会自动：

- 用 `git archive` 打出 `whale-girl-patch-<tag>.zip`；
- 创建/更新对应的 GitHub Release 并上传 ZIP；
- 说明文字取 `docs/release-notes-<tag>.md`（例如 `docs/release-notes-v1.0.0.md`；发新版本时新建对应文件）。

也可以手动生成 ZIP（在仓库目录）：

```powershell
git archive --format=zip --output="..\whale-girl-patch-v1.0.0.zip" v1.0.0
```

然后 GitHub → Releases → **Draft a new release**：

- Tag：`v1.0.0`（选已有 tag）
- Title：`v1.0.0 · 跨聊天记忆 + 链接阅读补丁`
- 说明：直接粘贴 `docs/release-notes-v1.0.0.md` 的内容
- 附件：上传 `whale-girl-patch-v1.0.0.zip`

这个 ZIP 里包含 `install.cmd` / `uninstall.cmd` / `patch\` / `launcher\`（带「补丁」页的启动器）/ 教程，
解压双击即可。发布前确认 `launcher/version.txt` 与当前适配的本体版本一致。

## 5. 发布前检查

```powershell
git status                 # 应该只有你主动改的文件
git log --oneline -3
git tag -n
```

- 不要提交 `data/`、`config.json`、API Key、聊天记录；`.gitignore` 已经忽略 `data/` 和 `*.log`。
- 截图 `docs/patch-ui.png` 里不要出现真实聊天内容 / 路径；当前截图是测试数据。
- 保持 `LICENSE`、`NOTICE.md` 原样；AGPL 要求分发修改版时提供完整源码。
- 确认仓库根目录能看到 `install.cmd`、`README.md`、`docs/tutorial.md`。

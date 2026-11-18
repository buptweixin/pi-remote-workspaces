# Pi Remote

[English](README.md) | 简体中文

让 **pi coding agent**、**pi-web** 和 **[PI-Desktop](https://github.com/vastsa/PI-Desktop)** 在 SSH 远程项目中读写文件、执行命令。参考 [dsh-remote](https://github.com/flymysql/dsh-remote) 的远程工作区体验，同时提供原生 pi 扩展与 PI-Desktop 原生插件。

- 动态发现 `~/.ssh/config`、系统配置和递归 `Include` 中的明确主机别名；支持通配 Include、双引号路径和多个 Host 别名。
- 真正的连接由系统 **OpenSSH** 完成，沿用 `ProxyJump`、`ProxyCommand`、IdentityFile、ssh-agent 和 Host/Match 规则；不复制或保存私钥、密码。
- 多个保存的工作区，每个会话独立绑定主机和目录；绑定记录持久化并在恢复或切换模型时保留。
- 在 **pi / pi-web** 中将 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 以及用户 `!` 命令路由到远程；在 **PI-Desktop** 中自动激活 `remote_read`、`remote_write`、`remote_edit`、`remote_bash`、`remote_ls`、`remote_find`、`remote_grep` 并与本地内置工具共存。
- `/remote` 配置菜单同时兼容 TUI、pi-web 和 PI-Desktop。管理工作台既可作为独立浏览器界面启动，也可在 PI-Desktop 右侧工作面板（`SSH 远程工作区`）或独立窗口内嵌运行，支持一键绑定/解绑当前聊天会话。
- 文件写入使用临时文件和原子替换；编辑与浏览器保存检测版本冲突，保留已有文件权限。远程连接错误不会回退到本地执行。

## 环境

本机：Node.js **≥ 22.19**，系统 `ssh`；远端：Linux/macOS、**Python 3.8+** 和 `bash`。搜索需要远端安装 `ripgrep`，Git 面板需要远端安装 `git`。

先在终端确认登录与主机指纹：

```sh
ssh your-ssh-alias
```

插件使用 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`，需要已信任的主机以及密钥或 ssh-agent。密码、交互式 MFA 和首次主机指纹确认应在终端完成。

## 安装

从 npm 安装：

```sh
pi install npm:@arnowei/pi-remote-workspaces
```

不保存到配置、仅临时试用：

```sh
pi -e npm:@arnowei/pi-remote-workspaces
```

也可以直接从 [GitHub 仓库](https://github.com/buptweixin/pi-remote-workspaces) 安装：

```sh
pi install git:github.com/buptweixin/pi-remote-workspaces
```

安装后重启 pi / pi-web，在会话中输入 `/remote` 即可配置。

### 从本地源码安装

在仓库目录执行：

```sh
npm install
npm run build

# 安装到 pi 的全局 packages 配置，pi-web 会读取同一份配置
pi install /absolute/path/to/pi_remote
```

如果没有全局 `pi` 命令：

```sh
npx @earendil-works/pi-coding-agent install /absolute/path/to/pi_remote
```

安装后重启 pi / pi-web。也可把仓库的绝对路径添加到 `~/.pi/agent/settings.json` 的 `packages` 数组中，保留已有条目：

```json
{
  "packages": ["/absolute/path/to/pi_remote"]
}
```

pi 的包清单在 `package.json` 的 `pi.extensions` 字段中，入口为 `src/extension.ts`，无需修改 pi-web。

## 开始使用

1. 在 pi 或 pi-web 对话框发送 **`/remote`**。
2. 选择「添加远程工作区」，从动态 SSH 主机列表选择别名，填写远程目录与名称。也可以通过「浏览器配置与文件管理」创建工作区。
3. 在 `/remote` 菜单中选择工作区，或发送 `/remote use <id>`。连接验证成功后，会话工具切换到远程项目。
4. 让 agent 开始工作；状态组件会显示当前 SSH 主机和项目根目录。

取消当前会话的远程绑定时，发送 `/remote local`，或在 `/remote` 菜单中选择「切换到本地」。保存的工作区配置会保留。

```text
/remote                  配置与工作区选择菜单
/remote add              从 SSH config 选择主机并添加工作区
/remote remove my-app    删除已保存的工作区配置
/remote hosts            重新读取 SSH config，显示主机及来源
/remote use my-app-dev   绑定已保存的工作区
/remote test             检查连接及 Python/Git/ripgrep 可用性
/remote status           查看当前工作区并检查连接
/remote web              启动本会话的浏览器配置与文件管理界面
/remote local            恢复本地工具
```

CLI 也支持启动时指定工作区：`pi --remote my-app-dev`。若指定的工作区无法连接，会话进入阻止执行状态；用 `/remote use <id>` 重新绑定，或显式 `/remote local`。

### pi-web

```sh
npx @agegr/pi-web@latest
```

在对话中发送 `/remote` 即可使用原生浏览器选择框与输入框；`/remote web` 会提供独立管理界面的链接。

已实际验证 **pi-web 0.17.0 + `@earendil-works/pi-coding-agent` 1.5.2** 的包加载、SSH 绑定、状态通知、配置选择框和 Stop 关闭流程，无需模型凭据或 LLM 调用。

pi-web 自带的文件栏和终端仍属于它的本地会话目录。查看远程文件和执行远程命令，请使用 Pi Remote 管理界面或已绑定会话的 agent 工具。当前没有向 pi-web 注入侧栏或修改宿主源码。

### PI-Desktop

适配 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)（已验证 **PI-Desktop 0.22.0+**），无第三方运行依赖，提供三种接入方式：

1. **安装 `.piplug` 原生插件包（推荐）**：
   先在本地执行 `npm run build`（或从 GitHub Release 下载 `.piplug`），打开 PI-Desktop → **Plugins** → 右上角菜单 **Install plugin package** → 选择 `release-artifacts/io.github.buptweixin.pi-remote-<version>.piplug`。
2. **加载开发插件目录（支持热重载）**：
   执行 `npm run build` 后，打开 PI-Desktop → **Plugins** → **Load development plugin** → 选择仓库下的 `pi-desktop` 目录。
3. **导入 pi 扩展（仅 Agent 扩展）**：
   打开 PI-Desktop → **Plugins** → 右上角菜单 **Import pi extension** → 选择本仓库根目录（零外部 npm 依赖，离线直接导入）。

在 PI-Desktop 中的体验：

- **聊天输入框内嵌胶囊与原生右侧面板**：在 PI-Desktop 聊天输入框左下角工具栏直接挂载 `SSH` 胶囊按钮（沿用宿主 `--ds-*` 主题变量），点击即可在主窗口内弹出原生浮层完成 SSH 主机选择、新建、连接测试与解绑；右侧工作面板中的「**SSH 远程**」视图采用与内置「文件管理器」一致的深浅色自适应紧凑布局，自动跟随当前会话，并支持目录树折叠、彩色 Git Diff、点击搜索结果跳转文件对应行以及远程命令执行。
- **双端工具共存**：由于 PI-Desktop 保留内置核心工具名（`Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep`），绑定远程工作区后会自动激活 `remote_read`、`remote_write`、`remote_edit`、`remote_bash`、`remote_ls`、`remote_find`、`remote_grep` 并注入远端 `AGENTS.md` / `CLAUDE.md` 上下文，同时保留本地内置工具可用，方便跨本机与远端协同操作。
- **斜杠命令**：在输入框输入 `/remote` 即可调用原生弹窗完成绑定、添加、删除、状态检查等全部子命令。

### 独立浏览器配置界面

不启动 agent 也能配置：

```sh
npx --yes --package @arnowei/pi-remote-workspaces pi-remote serve
```

本地源码开发时：

```sh
npm run dev
# 或构建后：
node dist/cli.js serve
node dist/cli.js serve --port 30142
```

打开命令输出的完整链接。服务只监听 `127.0.0.1`，API 使用随机访问令牌，并验证 Host/Origin；访问令牌放在 URL fragment 中，页面读取后会移除它。

侧栏可刷新 SSH 配置、添加和编辑工作区；设置面板可指定 SSH 配置文件与超时。工作区内可浏览/编辑 UTF-8 文本、搜索、查看 Git 差异和运行命令。保存前若远程内容已变化，会提示重新读取。

浏览器管理页和 pi 会话各自选择工作区：管理页顶部的 `/remote use <id>` 按钮可复制绑定命令。修改保存的工作区不会静默切换已绑定会话；需要再次运行 `/remote use <id>`。

如果 pi-web 运行在另一台服务器，`/remote web` 的地址属于那台服务器的 loopback。请用 SSH 转发该端口后访问，例如 `ssh -L 30142:127.0.0.1:<链接中的端口> server`，保留链接中的 `#token=...`，并用本机转发端口打开。命令行可用 `serve --port` 选择固定端口。

## 配置文件

默认写入 `~/.pi/agent/remote.json`，文件权限 `0600`。配置更新带跨进程锁，并通过原子替换保存。

- `PI_CODING_AGENT_DIR`：更改 pi 配置目录，与 pi-web / PI-Desktop 保持一致。
- `PI_REMOTE_CONFIG`：覆盖远程工作区配置文件路径。
- `PI_REMOTE_SESSIONS`：覆盖 PI-Desktop 会话绑定状态文件路径（默认与 `remote.json` 同目录下的 `remote-sessions.json`）。

```json
{
  "version": 1,
  "connectTimeoutSeconds": 10,
  "commandTimeoutSeconds": 120,
  "workspaces": [
    {
      "id": "my-app-dev",
      "name": "My App / 开发服务器",
      "host": "dev-server",
      "path": "~/projects/my-app"
    }
  ]
}
```

可选 `sshConfigPath` 为自定义配置文件的**绝对路径**。留空时使用系统 OpenSSH 默认规则；指定时通过 `ssh -F` 连接，因此不再加载系统配置。发现主机时遵循同样的文件选择规则；相对 `Include` 按用户 `~/.ssh` 或系统 `/etc/ssh` 解析。

每次刷新主机列表都重新读取配置和 Include 文件，每次 SSH 操作都会重新应用 OpenSSH 的连接配置，无需重启。不列出 `Host *`、`Host *.example.com` 和否定规则；可手动输入一个具体的主机名。主机发现只扫描声明，不执行 `Match exec`；连接与显式解析操作由 OpenSSH 自己计算生效配置。条件 Include 中发现的候选别名是否能连接，以 OpenSSH 的实际规则为准。

## CLI

```sh
node dist/cli.js hosts          # 动态 SSH 主机列表及来源
node dist/cli.js list           # 已保存的工作区
node dist/cli.js test my-app-dev
node dist/cli.js remove my-app-dev
node dist/cli.js --help
```

## 边界

- 文件工具和管理界面文件操作限制在绑定根目录内，拒绝 `..` 和指向根目录外的符号链接。**bash 是 SSH 用户权限下的 shell，不是文件系统沙箱**。其他扩展提供的工具不会自动迁移到远端；在 SSH 模式中阻止内置 PowerShell，使用 bash。
- 浏览器提供一次性命令执行，暂不提供 PTY、持久交互终端、语言服务、远程调试或编辑器语法高亮。
- 单个文件最大 8 MiB；目录最多 5000 项。浏览器命令输出最大 1 MiB，搜索和 Git 输出有截断限制。浏览器仅编辑 UTF-8 文本；统一 CRLF 文件在保存时保留 CRLF。
- 取消与超时会终止本机 SSH 进程组；远端命令、后台进程或自行脱离终端的进程可能继续运行。需要可靠的长任务管理时，请在远端使用 tmux 或其他进程管理器。
- agent 的模型调用、会话存储和 skills 仍在 pi 所在机器上；绑定远程工作区后，扩展会将系统提示中的工作目录设为远程根目录，并用远程根目录内的 `AGENTS.md` / `CLAUDE.md` 替换本地项目上下文。不同机器或权限模式之间切换，建议使用独立会话。
- 当前正式兼容目标为新版 `@earendil-works/pi-coding-agent`；尚未验证旧版 `@mariozechner/pi-coding-agent`。

## 开发与验证

```sh
npm run check
npm test                    # 配置发现、并发保存、文件协议、原生工具、API 权限等
npm run test:integration     # 本机临时 sshd + 真实 OpenSSH + SDK 会话隔离与恢复
npm run test:pi-web          # 额外通过 npx 启动最新 pi-web 做联调
npm run test:package         # 实际打包后，仅安装生产依赖并验证 CLI 和扩展加载
npm run build
npm pack --dry-run
```

集成测试创建临时主机密钥、授权密钥、known_hosts、SSH 配置和 pi 目录，只连接本机临时 sshd，不读取或修改用户的 SSH/pi 配置。需要 `ssh-keygen` 和 `/usr/sbin/sshd`；可用 `PI_REMOTE_SSHD` 覆盖 daemon 路径。pi-web 联调需要网络，默认执行 `npx @agegr/pi-web@latest`；`PI_REMOTE_PI_WEB_PACKAGE` 可固定待测版本。

源码：`src/extension.ts` 为 pi 接入层，`src/tools.ts` 适配原生工具，`src/ssh-config.ts` 发现和解析 SSH 配置，`src/remote.ts` / `src/remote-script.ts` 实现传输与远端协议，`src/server.ts` 和 `public/` 提供浏览器界面。远端 Python 辅助代码按需通过 SSH 执行，不安装常驻服务。

版本标签、发布流程和 npm Trusted Publishing 配置见[发布指南](docs/releasing.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 参考

- [dsh-remote](https://github.com/flymysql/dsh-remote)：远程工作区交互参考。
- [pi 扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) 与 [SSH 示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts)：工具操作接口。
- [pi-web](https://github.com/agegr/pi-web)：浏览器宿主。
- [PI-Desktop](https://github.com/vastsa/PI-Desktop)：桌面工作区宿主。

## 许可证

Pi Remote 原创代码使用 [MIT License](LICENSE)。上游致谢、pi SSH 示例的许可证声明，以及锁定版本的运行依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。第三方组件保留各自的许可证。

Pi Remote 是独立扩展，并非 pi、pi-web 或 dsh-remote 的官方发行版本。

由 [Arno Wei](https://github.com/buptweixin) 维护。

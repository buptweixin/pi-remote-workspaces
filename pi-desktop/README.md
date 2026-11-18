# Pi Remote for PI-Desktop

基于本机 OpenSSH 配置（`~/.ssh/config`、`ProxyJump`、`ProxyCommand`、`IdentityFile`、`ssh-agent`）的零远端部署 SSH 工作区插件，深度内嵌于 [PI-Desktop](https://github.com/vastsa/PI-Desktop) 原生 UI。

## 原生 UI 与功能

1. **聊天输入框工具栏内嵌胶囊 (`composerControl` Slot)**：
   - 直接挂载在 PI-Desktop 聊天输入框左下角（紧邻模式/权限切换按钮），沿用宿主 `--ds-*` 设计变量与圆角胶囊样式。
   - 未绑定时显示紧凑 `SSH` 胶囊，绑定后显示绿点与 `host:目录名`；点击即在主窗口内弹出原生浮层，可一键切换/添加/测试/断开 SSH 工作区，或一键展开右侧文件面板。
2. **原生风格右侧工作面板视图 (`SSH 远程`)**：
   - 与 PI-Desktop 内置「文件管理器」完全一致的深浅色主题同步（`app.getAppearance` / `appearance:changed`）、12px 紧凑排版与滚动条样式。
   - 自动跟随当前聊天会话绑定的 SSH 工作区；支持可折叠目录树、UTF-8 文件编辑与冲突校验保存、带颜色高亮的 Git 状态/Diff、点击搜索结果直达文件对应行，以及远程 bash 命令执行。
3. **双端工具共存 (`remote_*` + 本地内置工具) 与 `/remote` 斜杠命令**：
   - 会话绑定远程工作区后自动激活 `remote_read`、`remote_write`、`remote_edit`、`remote_bash`、`remote_ls`、`remote_find`、`remote_grep` 并注入远端 `AGENTS.md` / `CLAUDE.md` 上下文，同时保留本地内置工具可用。

## 权限说明

- `renderer.extension`：在聊天输入框挂载 SSH 工作区切换胶囊及主窗口内嵌选择浮层。
- `ui.view`：在右侧工作面板挂载「SSH 远程」视图。
- `ui.panel`：支持将「SSH 远程」工作台弹出为独立窗口。
- `clipboard.write`：复制绑定命令。
- `agent.extension`：在 Agent sidecar 中注册 `/remote` 命令、`remote_*` 远程工具与会话提示词注入。

## 更新与重新授权提示

> 如果此前已加载过旧版开发目录插件，由于本次新增了 `renderer.extension` 权限用于挂载聊天框内嵌按钮，请在 **PI-Desktop → Plugins** 对应插件行点击 **More (`⋯`) → Reload**（或重新安装最新 `.piplug`）并确认新增权限。

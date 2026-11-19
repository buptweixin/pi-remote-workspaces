# Changelog

## 0.5.0 - 2026-11-20

- Manage clean local anchor directories (`~/.pi/remote-workspaces/<workspace-id>` and shared `~/.pi/remote-workspaces`) so `pi-web` sessions can connect to SSH workspaces without piggybacking on a local project.
- Auto-bind saved SSH workspaces on `session_start` when opening a workspace anchor directory, and automatically open the SSH workspace picker modal on `session_start` when opening the shared anchor root (while preserving persisted session bindings and failing closed on unknown anchors or cancelled selection).
- Add `/remote anchors`, `pi-remote anchors`, `anchorRoot` configuration, `PI_REMOTE_ANCHOR_DIR` override, and dashboard copy/settings controls for anchor directories; tighten remote global context filtering and bundle `anchors.js` in the PI-Desktop plugin build.

## 0.4.0 - 2026-11-18

- Add native [pi-web](https://github.com/agegr/pi-web) status-shelf toolbar buttons (`ExtensionStatusBar` `command:` protocol) without patching `pi-web`: unbound sessions show a clickable `SSH: 本地` pill right below the chat composer, and bound sessions show `● SSH <host> · <path>`, `远程文件`, `Git 状态`, `探测连接`, and `切回本地` buttons alongside a collapsible ANSI details drawer (`▲ pi-remote`) while keeping `pi` CLI TUI unbound footers silent.
- Add in-modal remote file browser, `find`/`grep` search, file creation, and inline UTF-8 editor (`/remote files [path]`) powered by `ctx.ui.editor` with binary/size guards and optimistic `etag` conflict confirmation.
- Add in-modal remote Git status and per-file/full diff inspector (`/remote git`) plus interactive workspace editing (`/remote edit [id]`) and `/remote unbind` alias.
- Integrate with `pi-web`'s official `@agegr/pi-web/session-liveness/v1` registry to prevent automatic 10-minute idle session eviction during active interactive flows or while a `/remote web` standalone dashboard is running.

## 0.3.0 - 2026-11-18

- Add native [PI-Desktop](https://github.com/vastsa/PI-Desktop) plugin (`io.github.buptweixin.pi-remote`) with store-only `.piplug` packaging, development hot-reload support, and offline `Import pi extension` compatibility.
- Embed an in-composer SSH workspace selector pill (`composerControl` slot) and in-window management modal directly inside PI-Desktop's chat toolbar, alongside a Light/Dark-synced docked right Work Panel view (`SSH 远程`) with collapsible file tree, colored Git diffs, click-to-open search hits, and remote command execution.
- Add standalone `remote_read`, `remote_write`, `remote_edit`, `remote_bash`, `remote_ls`, `remote_find`, and `remote_grep` tools for PI-Desktop with automatic `setActiveTools` activation, remote `AGENTS.md` / `CLAUDE.md` prompt injection, live session binding synchronization (`remote-sessions.json`), and dual-end coexistence with local built-in tools.
- Replace `proper-lockfile` with a zero-dependency cross-process atomic directory lock and recover macOS `launchd` `SSH_AUTH_SOCK` inside minimal plugin utility processes.

## 0.2.0 - 2026-11-18

- Add session-scoped keep-alive SSH Python RPC worker pooling with automatic SSH config change rotation and idle cleanup.
- Reduce remote tool round-trips (`ls` from `3 + N` to 1 RPC, `read`, `write`, and `find` to 1 RPC, `edit` to 2 RPCs) and sniff image MIME types (including BMP) from fetched bytes.
- Inject remote `AGENTS.md` / `CLAUDE.md` project context and structured `<ssh_workspace>` prompt sections while isolating unrelated local context and strictly enforcing `blocked` mode across user input and tool calls.
- Stream remote `ripgrep --json` matches with early stop, relative paths, long-line truncation, and native `GrepToolDetails` metadata; preserve partial streamed `bash` output on timeout or cancellation.
- Harden remote RPC framing with sentinel markers, login-shell-independent `PATH` discovery, NFS directory lock fallback, and `umask`-aware file creation; skip non-discovery directives during SSH config scanning.
- Add `/remote` argument completions, `/remote remove` and `pi-remote remove`, readable workspace slug IDs, Dashboard new-file creation, keyboard shortcuts, case-insensitive search toggle, and live SSH host resolution preview.

## 0.1.1 - 2026-11-16

- Wait for asynchronous npm publication to become public before completing a release.
- Verify that the registry archive matches the archive tested by the release workflow.
- Display the installed package version in the dashboard instead of a hardcoded version.

## 0.1.0 - 2026-11-16

- Discover SSH aliases dynamically from OpenSSH configuration and recursive includes.
- Bind independent remote workspaces to pi sessions and restore bindings from session history.
- Run native read, write, edit, bash, grep, find, and ls tools on the remote host.
- Configure workspaces through `/remote` in pi TUI and pi-web, or through a standalone browser dashboard.
- Browse and edit remote files, search with ripgrep, inspect Git diffs, and execute bash commands.
- Detect stale file saves, serialize cooperating writes, preserve permissions, and replace files atomically.
- Reject file paths outside the workspace and never fall back to local execution after an SSH failure.
- Include English and Chinese documentation, upstream attribution, and runtime dependency license notices.
- Verify package installation, CLI startup, and extension discovery from the published archive layout.

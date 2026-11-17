# Changelog

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

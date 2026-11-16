# Changelog

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

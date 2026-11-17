# Pi Remote

English | [简体中文](README.zh-CN.md)

SSH workspaces for **pi coding agent** and **pi-web**. Let your agent read and edit files, search projects, and run commands on a remote host. Inspired by the workspace experience in [dsh-remote](https://github.com/flymysql/dsh-remote), implemented through pi's extension API.

- Discover concrete host aliases dynamically from `~/.ssh/config`, system configuration, and recursive `Include` directives. Supports glob includes, double-quoted paths, and multiple aliases per `Host` line.
- Use your system **OpenSSH** client, including `ProxyJump`, `ProxyCommand`, `IdentityFile`, ssh-agent, and Host/Match rules. No private keys or passwords are copied or stored by this extension.
- Save multiple workspaces and bind each pi session to its own host and directory. Bindings are stored in the session branch and restored when you resume it.
- Route pi's `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools, plus user `!` commands, to the remote workspace. Retain native file tools, image results, and edit diffs.
- Configure workspaces through `/remote` in either TUI or pi-web. A separate browser dashboard provides connection settings, file browsing and editing, content and filename search, Git status and diffs, and one-shot bash commands.
- Write files through temporary files and atomic replacement. Editing and dashboard saves check for version conflicts and preserve existing file permissions. SSH failures never fall back to local execution.

## Requirements

**Local:** Node.js **22.19 or later** and the system `ssh` client. **Remote:** Linux or macOS with **Python 3.8+** and `bash`. Remote search requires `ripgrep`; the Git panel requires `git` on the remote host.

First, confirm authentication and the host fingerprint in your terminal:

```sh
ssh your-ssh-alias
```

The extension uses `BatchMode=yes` and `StrictHostKeyChecking=yes`. Prepare a trusted host key and SSH key or ssh-agent authentication before connecting. Password prompts, interactive MFA, and first-time host-key confirmation must be handled in the terminal.

## Install

Install the published extension:

```sh
pi install npm:@arnowei/pi-remote-workspaces
```

Try it for one invocation without saving it to your settings:

```sh
pi -e npm:@arnowei/pi-remote-workspaces
```

You can also install directly from the [GitHub repository](https://github.com/buptweixin/pi-remote-workspaces):

```sh
pi install git:github.com/buptweixin/pi-remote-workspaces
```

Restart pi or pi-web after installation, then send `/remote` in a conversation.

### Install from a local checkout

From the repository directory:

```sh
npm install
npm run build

# Add this package to pi's global configuration, shared with pi-web.
pi install /absolute/path/to/pi_remote
```

If you do not have a global `pi` command:

```sh
npx @earendil-works/pi-coding-agent install /absolute/path/to/pi_remote
```

Restart pi or pi-web after installing. Alternatively, add the repository's absolute path to the `packages` array in `~/.pi/agent/settings.json`, preserving existing entries:

```json
{
  "packages": ["/absolute/path/to/pi_remote"]
}
```

The package declares `src/extension.ts` in `package.json` under `pi.extensions`. No pi-web source changes are required.

## Get started

1. Send **`/remote`** in a pi or pi-web conversation.
2. Choose **Add remote workspace** (`添加远程工作区`), select an SSH alias, and enter the remote directory and workspace name. You can also create workspaces through the browser dashboard.
3. Select the saved workspace in `/remote`, or send `/remote use <id>`. The session switches its tools to the remote project after verifying the connection.
4. Ask the agent to work on your project. The status widget shows the active SSH host and project root.

The extension menus and dashboard currently use Simplified Chinese. Command names and configuration keys are shown below.

```text
/remote                  Open the configuration and workspace menu
/remote add              Select an SSH host and add a workspace
/remote remove my-app    Remove a saved workspace configuration
/remote hosts            Reload SSH config and show aliases with their sources
/remote use my-app-dev   Bind this session to a saved workspace
/remote test             Check connectivity and Python/Git/ripgrep availability
/remote status           Show the current workspace and check connectivity
/remote web              Start this session's browser configuration dashboard
/remote local            Unbind the remote workspace and restore local tools
```

To disconnect a session, send `/remote local`, or choose **Switch to local** (`切换到本地`) from `/remote`. Saved workspace configurations remain available.

The CLI also accepts a workspace at startup: `pi --remote my-app-dev`. If the requested workspace cannot connect, execution is blocked. Recover with `/remote use <id>` or explicitly switch back with `/remote local`.

### pi-web

```sh
npx @agegr/pi-web@latest
```

Send `/remote` to use native browser selection and input dialogs. `/remote web` provides a link to the separate dashboard.

Integration has been tested with **pi-web 0.17.0 and `@earendil-works/pi-coding-agent` 1.5.2**, covering package loading, real SSH binding, notifications, configuration dialogs, and cancellation through Stop. These tests require no model credentials or LLM calls.

Pi-web's own file browser and terminal still use its local session directory. Use the Pi Remote dashboard or the bound agent tools for remote files and commands. This extension does not inject a sidebar or patch pi-web.

### Standalone browser dashboard

Configure workspaces without starting an agent:

```sh
npx --yes --package @arnowei/pi-remote-workspaces pi-remote serve
```

From a local checkout:

```sh
npm run dev
# Or, after building:
node dist/cli.js serve
node dist/cli.js serve --port 30142
```

Open the complete URL printed by the command. The server listens on `127.0.0.1` only, authenticates API requests with a random token, and validates Host and Origin headers. The access token is supplied in the URL fragment and removed from the address bar after the page reads it.

Use the sidebar to refresh SSH config and add or edit workspaces. Connection settings let you choose a configuration file and timeouts. Within a workspace, you can browse and edit UTF-8 text files, search, inspect Git diffs, and run commands. Saving is rejected if the remote file has changed since it was read.

The dashboard and pi session select workspaces independently. Copy the `/remote use <id>` command from the dashboard to bind a conversation. Editing a saved workspace does not silently change an existing session binding; run `/remote use <id>` again to apply it.

If pi-web runs on another server, the `/remote web` URL refers to that server's loopback interface. Forward its dashboard port with SSH, for example `ssh -L 30142:127.0.0.1:<dashboard-port> server`, then open the URL using your local forwarded port and retain `#token=...`. Use `serve --port` for a fixed dashboard port.

## Configuration

Configuration is stored in `~/.pi/agent/remote.json` by default, with file permissions `0600`. Updates use a cross-process lock and atomic replacement.

- `PI_CODING_AGENT_DIR`: override the pi configuration directory; use the same value for pi-web.
- `PI_REMOTE_CONFIG`: override the remote workspace configuration file path.

```json
{
  "version": 1,
  "connectTimeoutSeconds": 10,
  "commandTimeoutSeconds": 120,
  "workspaces": [
    {
      "id": "my-app-dev",
      "name": "My App / Development",
      "host": "dev-server",
      "path": "~/projects/my-app"
    }
  ]
}
```

The optional `sshConfigPath` must be an **absolute path** to a custom SSH configuration file. Leave it unset to use OpenSSH's default configuration. Setting it passes `ssh -F`, which disables the system configuration. Host discovery follows the same file-selection rules. Relative `Include` paths are resolved against the user's `~/.ssh` or the system's `/etc/ssh`, as appropriate.

Refreshing the host list rereads configuration files and their includes. Each SSH operation applies the current OpenSSH connection configuration, so changes do not require a restart. Wildcard and negated aliases such as `Host *` and `Host *.example.com` are not listed; enter a concrete hostname manually instead. Discovery scans declarations without executing `Match exec`. OpenSSH evaluates effective settings when connecting or explicitly resolving a host. Aliases discovered in conditional includes remain candidates whose connectivity depends on those rules.

## CLI

```sh
node dist/cli.js hosts          # SSH aliases and source locations
node dist/cli.js list           # Saved workspaces
node dist/cli.js test my-app-dev
node dist/cli.js remove my-app-dev
node dist/cli.js --help
```

## Limitations

- File tools and dashboard file operations stay within the bound root, rejecting traversal and symlinks that point outside it. **Bash runs with the SSH user's privileges and is not a filesystem sandbox.** Tools from other extensions are not automatically made remote. Built-in PowerShell is blocked in SSH mode; use bash.
- The dashboard runs one-shot commands. It does not provide a PTY, persistent interactive terminal, language server, remote debugger, or editor syntax highlighting.
- Files are limited to 8 MiB; directory listings to 5,000 entries. Dashboard command output is limited to 1 MiB. Search and Git output may be truncated. The dashboard edits UTF-8 text; files with consistent CRLF line endings retain CRLF when saved.
- Cancellation and timeouts terminate the local SSH process group. Remote commands, background jobs, or detached processes may keep running. Use tmux or another remote process manager for long-running work that needs reliable lifecycle management.
- Model calls, session storage, and skills remain on the machine running pi. When bound to a remote workspace, the extension sets the prompt working directory to the remote root and replaces local project context with remote `AGENTS.md` / `CLAUDE.md` instructions when present inside the bound root. Prefer separate sessions when switching machines or privilege levels.
- The supported host is the current `@earendil-works/pi-coding-agent`. Older `@mariozechner/pi-coding-agent` releases have not been tested.

## Development and verification

```sh
npm run check
npm test                    # Config discovery, concurrency, file protocol, tools, API access
npm run test:integration     # Temporary local sshd, real OpenSSH, SDK session isolation/resume
npm run test:pi-web          # Launch the latest pi-web through npx and test integration
npm run test:package         # Install the actual tarball without development dependencies
npm run build
npm pack --dry-run
```

Integration tests generate temporary host and client keys, known_hosts, SSH config, and pi directories. They connect only to a temporary local sshd and do not read or modify your SSH or pi configuration. Tests require `ssh-keygen` and `/usr/sbin/sshd`; set `PI_REMOTE_SSHD` to use a different daemon path. The pi-web test needs network access and runs `npx @agegr/pi-web@latest` by default. Set `PI_REMOTE_PI_WEB_PACKAGE` to pin the version under test.

Source layout:

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Pi lifecycle, commands, and session bindings |
| `src/tools.ts` | Native tool adapters |
| `src/ssh-config.ts` | SSH configuration discovery and resolution |
| `src/remote.ts`, `src/remote-script.ts` | SSH transport and remote protocol |
| `src/server.ts`, `public/` | Browser dashboard |

The Python helper runs on demand through SSH; no persistent remote service is installed.

Release instructions, version tags, and npm Trusted Publishing setup are documented in the [release guide](docs/releasing.md). See [CHANGELOG.md](CHANGELOG.md) for release history.

## References

- [dsh-remote](https://github.com/flymysql/dsh-remote): workspace interaction reference.
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) and [SSH example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts): tool delegation interfaces and implementation patterns.
- [pi-web](https://github.com/agegr/pi-web): browser host.

## License

Pi Remote's original code is licensed under the [MIT License](LICENSE). Upstream acknowledgments, the pi SSH example's license notice, and the locked runtime dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Third-party components retain their own licenses.

Pi Remote is an independent extension and is not an official release of pi, pi-web, or dsh-remote.

Maintained by [Arno Wei](https://github.com/buptweixin).

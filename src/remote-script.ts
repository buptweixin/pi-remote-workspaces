export const REMOTE_JSON_SENTINEL = "__PI_REMOTE_JSON__:";

/** Sent over stdin/SSH on demand; nothing is installed on the remote machine. */
export const remoteScript = String.raw`
import base64, errno, fcntl, hashlib, json, mimetypes, os, selectors, shutil, signal, stat, subprocess, sys, tempfile, time

SENTINEL = "__PI_REMOTE_JSON__:"
MAX_FILE = 8 * 1024 * 1024
MAX_GREP_BYTES = 50 * 1024
MAX_GREP_LINE = 500
_UMASK = os.umask(0o077)
os.umask(_UMASK)
for _extra_dir in (os.path.expanduser("~/.local/bin"), os.path.expanduser("~/.cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin"):
    if _extra_dir and _extra_dir not in os.environ.get("PATH", "").split(os.pathsep) and os.path.isdir(_extra_dir):
        os.environ["PATH"] = os.environ.get("PATH", "") + (os.pathsep if os.environ.get("PATH") else "") + _extra_dir

def kill_group(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()

def bounded(args, cwd, limit=150000, timeout=20):
    child = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    chunks, size, truncated = [], 0, False
    deadline = time.monotonic() + max(1, timeout)
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                raise RuntimeError("Remote subprocess timed out")
            for key, _ in selector.select(0.2):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if size < limit:
                    chunks.append(data[:limit - size])
                size += len(data)
                if size > limit:
                    truncated = True
                    kill_group(child)
                    return {"text": b"".join(chunks).decode("utf8", "replace"), "exitCode": 0, "truncated": True}
        code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
        return {"text": b"".join(chunks).decode("utf8", "replace"), "exitCode": code, "truncated": truncated}
    finally:
        selector.close()
        kill_group(child)
        child.stdout.close()

def clean_glob(value):
    neg = "!" if value.startswith("!") else ""
    rest = value[1:] if neg else value
    while rest.startswith("./"):
        rest = rest[2:]
    return (neg + rest) if rest else "."

def decode_rg(field):
    if not field:
        return ""
    if "text" in field:
        return field["text"]
    if "bytes" in field:
        return base64.b64decode(field["bytes"]).decode("utf8", "replace")
    return ""

def run_find(path, pattern, limit, timeout):
    is_dir = os.path.isdir(path)
    cwd = path if is_dir else os.path.dirname(path)
    target = "." if is_dir else os.path.basename(path)
    args = ["rg", "--no-config", "--files", "--hidden", "-g", "!.git", "-g", clean_glob(pattern), "--", target]
    child = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    selector.register(child.stderr, selectors.EVENT_READ)
    out_buf, err_chunks, results = b"", [], []
    truncated, killed_early = False, False
    deadline = time.monotonic() + max(1, timeout)
    try:
        while selector.get_map() and not killed_early:
            if time.monotonic() > deadline:
                raise RuntimeError("Remote search timed out")
            for key, _ in selector.select(0.2):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.fileobj is child.stderr:
                    err_chunks.append(data)
                    continue
                out_buf += data
                while b"\n" in out_buf:
                    raw_line, out_buf = out_buf.split(b"\n", 1)
                    entry = raw_line.rstrip(b"\r").decode("utf8", "replace").strip()
                    if not entry:
                        continue
                    rel = os.path.relpath(os.path.join(cwd, entry), path).replace("\\", "/") if is_dir else os.path.basename(entry)
                    if len(results) >= limit:
                        truncated = True
                        killed_early = True
                        break
                    results.append(rel)
        if not killed_early and out_buf.strip():
            entry = out_buf.rstrip(b"\r").decode("utf8", "replace").strip()
            rel = os.path.relpath(os.path.join(cwd, entry), path).replace("\\", "/") if is_dir else os.path.basename(entry)
            if len(results) >= limit:
                truncated = True
            else:
                results.append(rel)
        if killed_early:
            kill_group(child)
            code = 0
        else:
            code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
        if not killed_early and code > 1 and not results:
            err_text = b"".join(err_chunks).decode("utf8", "replace").strip()
            raise RuntimeError(err_text or ("ripgrep exited with code " + str(code)))
        return {"text": "\n".join(results), "exitCode": 0 if results else 1, "truncated": truncated}
    finally:
        selector.close()
        kill_group(child)
        child.stdout.close()
        child.stderr.close()

def run_grep(root, path, p, limit, timeout):
    is_dir = os.path.isdir(path)
    cwd = path if is_dir else root
    context_lines = max(0, min(int(p.get("context") or 0), 10))
    args = ["rg", "--no-config", "--json", "--line-number", "--color", "never", "--hidden", "-g", "!.git"]
    if p.get("ignoreCase"):
        args.append("--ignore-case")
    if p.get("literal"):
        args.append("--fixed-strings")
    if p.get("glob"):
        args += ["-g", clean_glob(str(p["glob"]))]
    if context_lines > 0:
        args += ["-C", str(context_lines)]
    args += ["--", p["pattern"], "." if is_dir else path]
    child = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    selector.register(child.stderr, selectors.EVENT_READ)
    out_buf, err_chunks, output_lines = b"", [], []
    output_bytes, match_count, trailing_end = 0, 0, 0
    last_file = None
    limit_hit, match_limit_reached, byte_truncated, lines_truncated, killed_early = False, False, False, False, False
    deadline = time.monotonic() + max(1, timeout)

    def push_line(file_path, line_num, line_text, is_match):
        nonlocal last_file, output_bytes, byte_truncated, lines_truncated
        last_file = file_path
        rel = os.path.relpath(os.path.join(path, file_path), path).replace("\\", "/") if is_dir else os.path.basename(file_path)
        if line_text.endswith("\n"):
            line_text = line_text[:-1]
        if line_text.endswith("\r"):
            line_text = line_text[:-1]
        if len(line_text) > MAX_GREP_LINE:
            line_text = line_text[:MAX_GREP_LINE] + "... [truncated]"
            lines_truncated = True
        sep = ":" if is_match else "-"
        formatted = f"{rel}{sep}{line_num}{sep} {line_text}"
        encoded_len = len(formatted.encode("utf8")) + (1 if output_lines else 0)
        if output_bytes + encoded_len > MAX_GREP_BYTES:
            byte_truncated = True
            return
        output_lines.append(formatted)
        output_bytes += encoded_len

    def handle_json_line(raw_line):
        nonlocal match_count, limit_hit, trailing_end, match_limit_reached, killed_early
        text = raw_line.strip()
        if not text:
            return
        try:
            event = json.loads(text)
        except Exception:
            return
        kind = event.get("type")
        if kind not in ("match", "context"):
            return
        data = event.get("data") or {}
        file_path = decode_rg(data.get("path"))
        line_num = data.get("line_number")
        if not file_path or not isinstance(line_num, int):
            return
        line_text = decode_rg(data.get("lines"))
        is_match = kind == "match"
        if not limit_hit:
            push_line(file_path, line_num, line_text, is_match)
            if is_match:
                match_count += 1
                if match_count >= limit:
                    limit_hit = True
                    trailing_end = line_num + context_lines
            return
        in_window = file_path == last_file and line_num <= trailing_end
        if in_window:
            push_line(file_path, line_num, line_text, False)
        if is_match:
            match_limit_reached = True
        if match_limit_reached and not (in_window and line_num < trailing_end):
            killed_early = True

    try:
        while selector.get_map() and not killed_early:
            if time.monotonic() > deadline:
                raise RuntimeError("Remote search timed out")
            for key, _ in selector.select(0.2):
                data = os.read(key.fileobj.fileno(), 16384)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.fileobj is child.stderr:
                    err_chunks.append(data)
                    continue
                out_buf += data
                while b"\n" in out_buf and not killed_early:
                    raw_line, out_buf = out_buf.split(b"\n", 1)
                    handle_json_line(raw_line)
        if not killed_early and out_buf.strip():
            handle_json_line(out_buf)
        if killed_early:
            kill_group(child)
            code = 0
        else:
            code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
        if not killed_early and code > 1:
            err_text = b"".join(err_chunks).decode("utf8", "replace").strip()
            raise RuntimeError(err_text or ("ripgrep exited with code " + str(code)))
        return {
            "text": "\n".join(output_lines),
            "exitCode": 0 if match_count > 0 else 1,
            "truncated": match_limit_reached or byte_truncated or lines_truncated,
            "matchLimitReached": limit if match_limit_reached else None,
            "byteTruncated": byte_truncated,
            "linesTruncated": lines_truncated,
        }
    finally:
        selector.close()
        kill_group(child)
        child.stdout.close()
        child.stderr.close()

def main(p):
    root = os.path.realpath(os.path.expanduser(p["root"]))
    if not os.path.isdir(root):
        raise RuntimeError("Workspace directory does not exist: " + root)
    cmd_timeout = max(5, min(int(p.get("timeout", 20)), 3600))
    def safe(value):
        if "\x00" in value:
            raise RuntimeError("NUL in path")
        target = os.path.realpath(os.path.join(root, os.path.expanduser(value)))
        if os.path.commonpath([root, target]) != root:
            raise RuntimeError("Path escapes the remote workspace (including symlinks): " + value)
        return target
    op = p["op"]
    path = safe(p.get("path", "."))
    if op == "probe":
        return {"root": root, "home": os.path.expanduser("~"), "hostname": os.uname().nodename, "python": sys.version.split()[0], "git": bool(shutil.which("git")), "ripgrep": bool(shutil.which("rg"))}
    if op == "context":
        for name in ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"):
            candidate = os.path.join(root, name)
            if not os.path.lexists(candidate):
                continue
            try:
                resolved = safe(name)
                if not os.path.isfile(resolved) or os.path.getsize(resolved) > 65536:
                    continue
                with open(resolved, "rb") as file:
                    content = file.read(65536).decode("utf8")
                if content.startswith("\ufeff"):
                    content = content[1:]
                return [{"path": candidate, "content": content}]
            except Exception:
                continue
        return []
    if op == "access":
        if not os.access(path, os.R_OK): raise RuntimeError("File is not readable: " + path)
        return True
    if op == "stat":
        return {"exists": os.path.exists(path), "directory": os.path.isdir(path), "mime": mimetypes.guess_type(path)[0]}
    if op == "list":
        if not os.path.exists(path): raise RuntimeError("Path not found: " + path)
        if not os.path.isdir(path): raise RuntimeError("Not a directory: " + path)
        entries = []
        with os.scandir(path) as iterator:
            for item in iterator:
                if len(entries) >= 5000: raise RuntimeError("Directory has more than 5000 entries; use search")
                is_sym = item.is_symlink()
                escaped = False
                if is_sym:
                    try:
                        resolved = os.path.realpath(item.path)
                        if os.path.commonpath([root, resolved]) != root:
                            is_dir, escaped = False, True
                        else:
                            is_dir = os.path.isdir(resolved)
                    except OSError:
                        is_dir, escaped = False, True
                else:
                    is_dir = item.is_dir(follow_symlinks=False)
                entry = {"name": item.name, "directory": is_dir, "symlink": is_sym}
                if escaped:
                    entry["escaped"] = True
                entries.append(entry)
        return sorted(entries, key=lambda item: (not item["directory"], item["name"].lower()))
    if op == "read":
        if not os.path.exists(path): raise RuntimeError("File not found: " + path)
        if os.path.isdir(path): raise RuntimeError("Path is a directory: " + path)
        if p.get("writable") and not os.access(path, os.R_OK | os.W_OK):
            raise RuntimeError("File is not writable: " + path)
        with open(path, "rb") as file: data = file.read(MAX_FILE + 1)
        if len(data) > MAX_FILE: raise RuntimeError("File exceeds 8 MiB; use bash to inspect a range")
        return {"data": base64.b64encode(data).decode(), "etag": hashlib.sha256(data).hexdigest()}
    if op == "mkdir":
        os.makedirs(path, exist_ok=True)
        return True
    if op == "write":
        data = base64.b64decode(p["data"], validate=True)
        if len(data) > MAX_FILE: raise RuntimeError("File exceeds 8 MiB")
        if os.path.isdir(path): raise RuntimeError("Path is a directory: " + path)
        parent = safe(os.path.dirname(path))
        os.makedirs(parent, exist_ok=True)
        # A directory advisory lock serializes cooperating writers across SSH
        # processes without leaving lock files in the project; gracefully skip
        # on network filesystems (NFS/SSHFS) that reject directory flock.
        lock = os.open(parent, os.O_RDONLY)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX)
            except OSError as err:
                if err.errno not in (errno.ENOLCK, errno.EOPNOTSUPP, errno.ENOTSUP, errno.EINVAL, errno.EBADF):
                    raise
            if "etag" in p:
                try:
                    with open(path, "rb") as old: current = hashlib.sha256(old.read(MAX_FILE + 1)).hexdigest()
                except FileNotFoundError: current = None
                if current != p["etag"]:
                    if p["etag"] is None:
                        raise RuntimeError("File already exists remotely: " + p.get("path", path))
                    raise RuntimeError("File changed remotely. Reload before saving (conflict).")
            mode = stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else (0o666 & ~_UMASK)
            fd, temporary = tempfile.mkstemp(prefix=".pi-remote-", dir=parent)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(data)
                    file.flush()
                    os.fsync(file.fileno())
                os.chmod(temporary, mode)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        finally:
            os.close(lock)
        return {"etag": hashlib.sha256(data).hexdigest()}
    if op == "git":
        if not shutil.which("git"): raise RuntimeError("git is not installed on this host")
        args = ["git", "--no-pager", "-c", "core.quotePath=false", "-c", "color.ui=false"]
        action = p.get("action", "status")
        if action == "status": args += ["status", "--short", "--branch", "--", root]
        elif action in ["diff", "staged"]: args += ["diff", "--no-ext-diff", "--no-textconv"] + (["--cached"] if action == "staged" else []) + ["--", root]
        else: raise RuntimeError("Unknown Git action")
        return bounded(args, root, timeout=cmd_timeout)
    if op in ["grep", "find"]:
        if not os.path.exists(path): raise RuntimeError("Path not found: " + path)
        if not shutil.which("rg"): raise RuntimeError("Remote search requires ripgrep (rg). Install it on this host, or use bash with find/grep.")
        if op == "find":
            limit = max(1, min(int(p.get("limit", 1000)), 10000))
            return run_find(path, p["pattern"], limit, cmd_timeout)
        limit = max(1, min(int(p.get("limit", 100)), 2000))
        return run_grep(root, path, p, limit, cmd_timeout)
    raise RuntimeError("Unknown remote operation: " + op)

_protocol_out = sys.stdout
sys.stdout = sys.stderr

def emit(payload):
    _protocol_out.write(SENTINEL + json.dumps(payload) + "\n")
    _protocol_out.flush()

if "--loop" in sys.argv[1:]:
    emit({"ready": True})
    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        req_id = None
        try:
            request = json.loads(raw_line)
            req_id = request.get("id")
            emit({"id": req_id, "ok": True, "value": main(request)})
        except Exception as error:
            emit({"id": req_id, "ok": False, "error": str(error)})
else:
    try:
        request = json.load(sys.stdin)
        emit({"ok": True, "value": main(request)})
    except Exception as error:
        emit({"ok": False, "error": str(error)})
`;

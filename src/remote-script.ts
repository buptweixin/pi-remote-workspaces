/** Sent over stdin/SSH on demand; nothing is installed on the remote machine. */
export const remoteScript = String.raw`
import base64, fcntl, hashlib, json, mimetypes, os, selectors, shutil, stat, subprocess, sys, tempfile, time

MAX_FILE = 8 * 1024 * 1024

def bounded(args, cwd, limit=150000, timeout=20):
    child = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    chunks, size, truncated = [], 0, False
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            if time.monotonic() > deadline:
                raise RuntimeError("Remote subprocess timed out")
            for key, _ in selector.select(0.2):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                chunks.append(data[:max(0, limit-size)])
                size += len(data)
                if size > limit:
                    truncated = True
                    return {"text": b"".join(chunks).decode("utf8", "replace"), "exitCode": 0, "truncated": True}
        code = child.wait(timeout=max(0.1, deadline-time.monotonic()))
        return {"text": b"".join(chunks).decode("utf8", "replace"), "exitCode": code, "truncated": truncated}
    finally:
        selector.close()
        if child.poll() is None:
            import signal
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        child.stdout.close()

def main(p):
    root = os.path.realpath(os.path.expanduser(p["root"]))
    if not os.path.isdir(root):
        raise RuntimeError("Workspace directory does not exist: " + root)
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
    if op == "access":
        if not os.access(path, os.R_OK): raise RuntimeError("File is not readable: " + path)
        return True
    if op == "stat":
        return {"exists": os.path.exists(path), "directory": os.path.isdir(path), "mime": mimetypes.guess_type(path)[0]}
    if op == "list":
        entries = []
        with os.scandir(path) as iterator:
            for item in iterator:
                if len(entries) >= 5000: raise RuntimeError("Directory has more than 5000 entries; use search")
                entries.append({"name": item.name, "directory": item.is_dir(follow_symlinks=False), "symlink": item.is_symlink()})
        return sorted(entries, key=lambda item: (not item["directory"], item["name"].lower()))
    if op == "read":
        with open(path, "rb") as file: data = file.read(MAX_FILE + 1)
        if len(data) > MAX_FILE: raise RuntimeError("File exceeds 8 MiB; use bash to inspect a range")
        return {"data": base64.b64encode(data).decode(), "etag": hashlib.sha256(data).hexdigest()}
    if op == "mkdir":
        os.makedirs(path, exist_ok=True)
        return True
    if op == "write":
        data = base64.b64decode(p["data"], validate=True)
        if len(data) > MAX_FILE: raise RuntimeError("File exceeds 8 MiB")
        parent = safe(os.path.dirname(path))
        os.makedirs(parent, exist_ok=True)
        # A directory advisory lock serializes cooperating writers across SSH
        # processes without leaving lock files in the project.
        lock = os.open(parent, os.O_RDONLY)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if "etag" in p:
                try:
                    with open(path, "rb") as old: current = hashlib.sha256(old.read(MAX_FILE + 1)).hexdigest()
                except FileNotFoundError: current = None
                if current != p["etag"]: raise RuntimeError("File changed remotely. Reload before saving (conflict).")
            mode = stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else 0o644
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
        return bounded(args, root)
    if op in ["grep", "find"]:
        if not shutil.which("rg"): raise RuntimeError("Remote search requires ripgrep (rg). Install it on this host, or use bash with find/grep.")
        limit = max(1, min(int(p.get("limit", 100)), 2000))
        if op == "find":
            args = ["rg", "--files", "--hidden", "-g", "!.git", "-g", p["pattern"], "--", path]
        else:
            args = ["rg", "--line-number", "--with-filename", "--color", "never", "--hidden", "-g", "!.git", "--max-count", str(limit)]
            if p.get("ignoreCase"): args += ["--ignore-case"]
            if p.get("literal"): args += ["--fixed-strings"]
            if p.get("glob"): args += ["-g", p["glob"]]
            if p.get("context"): args += ["-C", str(max(0, min(int(p["context"]), 10)))]
            args += ["--", p["pattern"], path]
        result = bounded(args, root)
        if result["exitCode"] > 1: raise RuntimeError(result["text"])
        lines = result["text"].splitlines()
        result["truncated"] = result["truncated"] or len(lines) > limit
        if op == "find": lines = [os.path.relpath(line, path) for line in lines]
        result["text"] = "\n".join(lines[:limit])
        return result
    raise RuntimeError("Unknown remote operation: " + op)

try:
    request = json.load(sys.stdin)
    print(json.dumps({"ok": True, "value": main(request)}))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error)}))
`;

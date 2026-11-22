export const REMOTE_JSON_SENTINEL = "__PI_REMOTE_JSON__:";

/** Sent over stdin/SSH on demand; nothing is installed on the remote machine. */
export const remoteScript = String.raw`
import base64, errno, fcntl, fnmatch, hashlib, json, mimetypes, os, re, selectors, shutil, signal, stat, subprocess, sys, tempfile, time

SENTINEL = "__PI_REMOTE_JSON__:"
MAX_FILE = 8 * 1024 * 1024
MAX_STREAM_SCAN = 128 * 1024 * 1024
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

def _glob_to_regex(pat):
    i, n, out = 0, len(pat), ["^"]
    while i < n:
        ch = pat[i]
        if ch == "*":
            if i + 1 < n and pat[i + 1] == "*":
                if i + 2 < n and pat[i + 2] == "/":
                    out.append("(?:.+/)?")
                    i += 3
                    continue
                out.append(".*")
                i += 2
                continue
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        elif ch == "[" and "]" in pat[i + 1:]:
            end = pat.index("]", i + 1)
            inner = pat[i + 1:end]
            if inner.startswith("!"):
                inner = "^" + inner[1:]
            out.append("[" + inner + "]")
            i = end
        elif ch == "{" and "}" in pat[i + 1:]:
            end = pat.index("}", i + 1)
            alts = [_glob_to_regex(part)[1:-1] for part in pat[i + 1:end].split(",")]
            out.append("(?:" + "|".join(alts) + ")")
            i = end
        else:
            out.append(re.escape(ch))
        i += 1
    out.append("$")
    return "".join(out)

def compile_glob_matcher(raw_pattern):
    cleaned = clean_glob(str(raw_pattern or "*"))
    negate = cleaned.startswith("!")
    core = cleaned[1:] if negate else cleaned
    if not core or core == ".":
        return lambda _rel: not negate
    has_slash = "/" in core
    if not has_slash and "{" not in core and "**" not in core:
        return lambda rel: (not fnmatch.fnmatchcase(os.path.basename(rel), core)) if negate else fnmatch.fnmatchcase(os.path.basename(rel), core)
    compiled = re.compile(_glob_to_regex(core))
    return lambda rel: (compiled.match(rel if has_slash else os.path.basename(rel)) is None) if negate else (compiled.match(rel if has_slash else os.path.basename(rel)) is not None)

def iter_fallback_files(root, search_dir, deadline):
    if shutil.which("git"):
        try:
            proc = subprocess.run(
                ["git", "-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                cwd=search_dir,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=max(1.0, deadline - time.monotonic()),
                check=False,
            )
            if proc.returncode == 0:
                entries = []
                for raw_entry in proc.stdout.split(b"\x00"):
                    if not raw_entry:
                        continue
                    rel = raw_entry.decode("utf8", "replace").replace("\\", "/")
                    if rel == ".git" or rel.startswith(".git/") or "/.git/" in rel:
                        continue
                    full = os.path.join(search_dir, rel)
                    try:
                        resolved = os.path.realpath(full)
                        if os.path.commonpath([root, resolved]) != root or not os.path.isfile(resolved):
                            continue
                    except OSError:
                        continue
                    entries.append(rel)
                entries.sort()
                return entries
        except subprocess.TimeoutExpired:
            raise RuntimeError("Remote search timed out")
        except Exception:
            pass
    collected = []
    for cur_dir, dirs, files in os.walk(search_dir, followlinks=False):
        if time.monotonic() > deadline:
            raise RuntimeError("Remote search timed out")
        dirs[:] = sorted(d for d in dirs if d != ".git" and not os.path.islink(os.path.join(cur_dir, d)))
        for fname in sorted(files):
            full = os.path.join(cur_dir, fname)
            try:
                resolved = os.path.realpath(full)
                if os.path.commonpath([root, resolved]) != root or not os.path.isfile(resolved):
                    continue
            except OSError:
                continue
            collected.append(os.path.relpath(full, search_dir).replace("\\", "/"))
    return collected

def run_find_fallback(root, path, pattern, limit, timeout):
    deadline = time.monotonic() + max(1, timeout)
    matcher = compile_glob_matcher(pattern)
    if not os.path.isdir(path):
        name = os.path.basename(path)
        matched = [name] if matcher(name) else []
        return {"text": "\n".join(matched[:limit]), "exitCode": 0 if matched else 1, "truncated": len(matched) > limit}
    results, truncated = [], False
    for rel in iter_fallback_files(root, path, deadline):
        if time.monotonic() > deadline:
            raise RuntimeError("Remote search timed out")
        if not matcher(rel):
            continue
        if len(results) >= limit:
            truncated = True
            break
        results.append(rel)
    return {"text": "\n".join(results), "exitCode": 0 if results else 1, "truncated": truncated}

def run_grep_fallback(root, path, p, limit, timeout):
    deadline = time.monotonic() + max(1, timeout)
    is_dir = os.path.isdir(path)
    context_lines = max(0, min(int(p.get("context") or 0), 10))
    flags = re.IGNORECASE if p.get("ignoreCase") else 0
    raw_pat = str(p["pattern"])
    try:
        regex = re.compile(re.escape(raw_pat) if p.get("literal") else raw_pat, flags)
    except re.error as err:
        raise RuntimeError("Invalid regex pattern: " + str(err))
    glob_matcher = compile_glob_matcher(p["glob"]) if p.get("glob") else None
    candidates = iter_fallback_files(root, path, deadline) if is_dir else [os.path.basename(path)]
    output_lines = []
    output_bytes, match_count = 0, 0
    match_limit_reached, byte_truncated, lines_truncated = False, False, False

    def emit_line(rel_label, line_num, line_text, is_match):
        nonlocal output_bytes, byte_truncated, lines_truncated
        if len(line_text) > MAX_GREP_LINE:
            line_text = line_text[:MAX_GREP_LINE] + "... [truncated]"
            lines_truncated = True
        sep = ":" if is_match else "-"
        formatted = f"{rel_label}{sep}{line_num}{sep} {line_text}"
        encoded_len = len(formatted.encode("utf8")) + (1 if output_lines else 0)
        if output_bytes + encoded_len > MAX_GREP_BYTES:
            byte_truncated = True
            return
        output_lines.append(formatted)
        output_bytes += encoded_len

    for rel in candidates:
        if time.monotonic() > deadline:
            raise RuntimeError("Remote search timed out")
        if glob_matcher and not glob_matcher(rel):
            continue
        full = os.path.join(path, rel) if is_dir else path
        try:
            st = os.stat(full)
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE:
                continue
            with open(full, "rb") as file:
                raw_bytes = file.read(MAX_FILE)
        except OSError:
            continue
        if b"\x00" in raw_bytes[:8192]:
            continue
        text = raw_bytes.decode("utf8", "replace")
        lines = text.splitlines()
        hit_indices = []
        for idx, line in enumerate(lines):
            if regex.search(line):
                hit_indices.append(idx)
        if not hit_indices:
            continue
        accepted_hits = []
        for idx in hit_indices:
            if match_count < limit:
                match_count += 1
                accepted_hits.append(idx)
            else:
                match_limit_reached = True
                break
        if accepted_hits:
            hit_set = set(accepted_hits)
            shown = set()
            for h_idx in accepted_hits:
                for c_idx in range(max(0, h_idx - context_lines), min(len(lines), h_idx + context_lines + 1)):
                    shown.add(c_idx)
            for c_idx in sorted(shown):
                emit_line(rel, c_idx + 1, lines[c_idx], c_idx in hit_set)
        if match_limit_reached:
            break

    return {
        "text": "\n".join(output_lines),
        "exitCode": 0 if match_count > 0 else 1,
        "truncated": match_limit_reached or byte_truncated or lines_truncated,
        "matchLimitReached": limit if match_limit_reached else None,
        "byteTruncated": byte_truncated,
        "linesTruncated": lines_truncated,
    }

def is_image_header(head):
    if len(head) >= 4 and head[0] == 0xFF and head[1] == 0xD8 and head[2] == 0xFF and head[3] != 0xF7:
        return True
    if len(head) >= 16 and head[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    if len(head) >= 6 and head[:6] in (b"GIF87a", b"GIF89a"):
        return True
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return True
    if len(head) >= 26 and head[:2] == b"BM":
        return True
    return False

def read_text_lines(path, offset, limit, max_bytes):
    if not os.path.exists(path):
        raise RuntimeError("File not found: " + path)
    if os.path.isdir(path):
        raise RuntimeError("Path is a directory: " + path)
    start = max(1, int(offset or 1))
    max_lines = max(1, min(5000, int(limit or 2000)))
    cap_bytes = max(1024, int(max_bytes or 51200))
    file_size = os.path.getsize(path)
    if file_size > MAX_STREAM_SCAN:
        raise RuntimeError("File exceeds 128 MiB; use bash with sed/head/tail to inspect ranges")
    selected = []
    sel_bytes = 0
    truncated_by_bytes = False
    line_no = 0
    first_chunk = True
    remainder = b""
    end_target = start - 1 + max_lines

    def consume_line(raw_line):
        nonlocal line_no, sel_bytes, truncated_by_bytes
        line_no += 1
        if line_no < start or line_no > end_target or truncated_by_bytes:
            return
        decoded = raw_line.rstrip(b"\r").decode("utf8", "replace")
        if line_no == 1 and decoded.startswith("\ufeff"):
            decoded = decoded[1:]
        encoded_len = len(decoded.encode("utf8")) + 1
        if selected and sel_bytes + encoded_len > cap_bytes:
            truncated_by_bytes = True
            return
        selected.append(decoded)
        sel_bytes += encoded_len

    with open(path, "rb") as file:
        while True:
            chunk = file.read(65536)
            if not chunk:
                break
            if first_chunk:
                first_chunk = False
                if file_size <= MAX_FILE and is_image_header(chunk[:32]):
                    return {"image": True}
                if b"\x00" in chunk[:8192]:
                    raise RuntimeError("Binary file cannot be displayed as UTF-8 text: " + path)
            buf = remainder + chunk
            parts = buf.split(b"\n")
            remainder = parts[-1]
            for raw_line in parts[:-1]:
                consume_line(raw_line)
        consume_line(remainder)

    return {
        "image": False,
        "text": "\n".join(selected),
        "startLine": start,
        "endLine": start + len(selected) - 1,
        "totalLines": line_no,
        "truncatedByBytes": truncated_by_bytes,
    }

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
    if op == "read_lines":
        return read_text_lines(path, p.get("offset", 1), p.get("limit", 2000), p.get("maxBytes", 51200))
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
        target = safe(os.path.join(root, p["path"])) if p.get("path") else root
        if action == "status": args += ["status", "--short", "--branch", "--", target]
        elif action in ["diff", "staged"]: args += ["diff", "--no-ext-diff", "--no-textconv"] + (["--cached"] if action == "staged" else []) + ["--", target]
        else: raise RuntimeError("Unknown Git action")
        return bounded(args, root, timeout=cmd_timeout)
    if op in ["grep", "find"]:
        if not os.path.exists(path): raise RuntimeError("Path not found: " + path)
        has_rg = bool(shutil.which("rg"))
        if op == "find":
            limit = max(1, min(int(p.get("limit", 1000)), 10000))
            return run_find(path, p["pattern"], limit, cmd_timeout) if has_rg else run_find_fallback(root, path, p["pattern"], limit, cmd_timeout)
        limit = max(1, min(int(p.get("limit", 100)), 2000))
        return run_grep(root, path, p, limit, cmd_timeout) if has_rg else run_grep_fallback(root, path, p, limit, cmd_timeout)
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

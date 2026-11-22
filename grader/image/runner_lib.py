"""Helpers for runner.sh (DESIGN.md §6.3): parse job.json, check nm symbols, emit RunnerOutput.

It never runs student code and never sees expected output. Called as
  python3 -I runner_lib.py prepare <job.json> <meta_dir>
  python3 -I runner_lib.py nm_check <nm_raw> <allow.txt> <res_dir>
  python3 -I runner_lib.py asm_check <objdump_out> <res_dir>
  python3 -I runner_lib.py emit <stage> <meta_dir> <res_dir>
"""
import base64
import json
import os
import re
import signal
import sys

RUNNER_VERSION = "1"
STDERR_CAP = 16 * 1024
SAFE_FILE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")
SAFE_FLAG = re.compile(r"^-[A-Za-z0-9_=+.,:/-]+$")


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def read_text(path, default=""):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return default.encode()


def capped(path):
    data = read_text(path)
    if len(data) > STDERR_CAP:
        data = data[:STDERR_CAP] + b"\n[... truncated at 16 KiB]\n"
    return data.decode("utf-8", "replace")


def as_int(v, lo, hi):
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise ValueError(f"bad integer {v!r}")
    return v


def prepare(job_path, meta):
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    kind = job["kind"]
    if kind not in ("program", "function"):
        raise ValueError("bad kind")
    student = job["student_file"]
    if not isinstance(student, str) or not SAFE_FILE.match(student) or not student.endswith(".c"):
        raise ValueError("bad student_file")
    flags = job["cflags_extra"]
    if not isinstance(flags, list) or not all(isinstance(x, str) and SAFE_FLAG.match(x) for x in flags):
        raise ValueError("bad cflags_extra")
    write(f"{meta}/kind", kind)
    write(f"{meta}/student_file", student)
    write(f"{meta}/has_main", "1" if job["has_main"] else "0")
    write(f"{meta}/allow_asm", "1" if job.get("allow_asm") is True else "0")
    write(f"{meta}/cflags", "\n".join(flags))
    write(f"{meta}/compile_timeout_s", str(as_int(job["compile_timeout_s"], 1, 60)))
    write(f"{meta}/test_timeout_ms", str(as_int(job["test_timeout_ms"], 1, 60000)))
    write(f"{meta}/test_cpu_s", str(as_int(job["test_cpu_s"], 1, 60)))
    write(f"{meta}/max_output_bytes", str(as_int(job["max_output_bytes"], 1, 4 * 1024 * 1024)))
    tests = job["tests"]
    write(f"{meta}/ntests", str(len(tests)))
    ids = []
    for i, t in enumerate(tests):
        d = f"{meta}/t{i}"
        os.mkdir(d)
        ids.append(str(t["id"]))
        argv = t["argv"]
        if not isinstance(argv, list) or not all(isinstance(a, str) and "\0" not in a for a in argv):
            raise ValueError("bad argv")
        write(f"{d}/argc", str(len(argv)))
        for j, a in enumerate(argv):
            with open(f"{d}/arg{j}", "wb") as f:
                f.write(a.encode("utf-8"))
        if t.get("stdin_b64") is not None:
            with open(f"{d}/stdin", "wb") as f:
                f.write(base64.b64decode(t["stdin_b64"], validate=True))
    write(f"{meta}/ids", json.dumps(ids))


def nm_symbols(nm_raw):
    syms = []
    for line in read_text(nm_raw).decode("utf-8", "replace").splitlines():
        parts = line.split()
        if not parts:
            continue
        name = parts[-1]
        if name.startswith("_"):
            name = name[1:]
        if name and name not in syms:
            syms.append(name)
    return syms


def nm_check(nm_raw, allow_path, res):
    allow = {l.strip() for l in read_text(allow_path).decode("utf-8", "replace").splitlines() if l.strip()}
    syms = nm_symbols(nm_raw)
    forbidden = [s for s in syms if s not in allow]
    write(f"{res}/nm_symbols", json.dumps(syms))
    write(f"{res}/forbidden", "\n".join(forbidden))


# Instructions that enter the kernel: x86-64 syscall/sysenter/int, aarch64 svc.
FORBIDDEN_INSNS = {"syscall", "sysenter", "int", "svc"}
INSN_PREFIXES = {"lock", "rep", "repe", "repz", "repne", "repnz", "notrack", "bnd", "data16", "addr32",
                 "cs", "ds", "es", "fs", "gs", "ss", "rex", "rex.w", "rex.b", "rex.x", "rex.r"}


def mnemonics(objdump_text):
    """Instruction mnemonics from `objdump -d --no-show-raw-insn` output."""
    for line in objdump_text.splitlines():
        # "   4:\tsyscall" / "  10:\tint    $0x80" / "   8:\tsvc\t#0x0"
        head, sep, insn = line.partition(":")
        if not sep or not head.strip() or any(c not in "0123456789abcdefABCDEF" for c in head.strip()):
            continue
        tokens = insn.replace("\t", " ").split()
        while tokens and tokens[0].lower() in INSN_PREFIXES:
            tokens = tokens[1:]
        if tokens:
            yield tokens[0].lower()


def asm_check(objdump_path, res):
    text = read_text(objdump_path).decode("utf-8", "replace")
    found = sorted({m for m in mnemonics(text) if m in FORBIDDEN_INSNS})
    if found:
        write(f"{res}/static", "forbidden construct: asm")
        write(f"{res}/static_insns", "\n".join(found))


def rc(path):
    try:
        return int(read_text(path, "1").decode().strip() or "1")
    except ValueError:
        return 1


def sig_name(n):
    try:
        return signal.Signals(n).name
    except ValueError:
        return f"SIG{n}"


def test_result(test_id, rd, max_out, test_ms, cpu_s):
    out = read_text(f"{rd}/out")
    truncated = len(out) > max_out
    if truncated:
        out = out[:max_out]
    status = rc(f"{rd}/rc")
    ms = rc(f"{rd}/ms") if os.path.exists(f"{rd}/ms") else 0
    exit_code, sig, timed_out = status, None, False
    if status > 128:
        exit_code = None
        n = status - 128
        if n == signal.SIGKILL and ms >= min(test_ms, cpu_s * 1000) - 100:
            # timeout -s KILL (wall) or RLIMIT_CPU (ulimit -t): both are a timeout.
            timed_out = True
        elif n == signal.SIGPIPE and truncated:
            # Our head -c max+1 closed the pipe: an artifact of truncation, not a crash.
            pass
        else:
            sig = sig_name(n)
    return {
        "id": test_id,
        "stdout_b64": base64.b64encode(out).decode(),
        "exit": exit_code,
        "signal": sig,
        "timed_out": timed_out,
        "truncated": truncated,
        "duration_ms": ms,
    }


def emit(stage, meta, res):
    out = {
        "runner_version": RUNNER_VERSION,
        "stage": stage,
        "compile_ok": os.path.exists(f"{res}/compile_rc") and rc(f"{res}/compile_rc") == 0,
        "compile_stderr": capped(f"{res}/compile_stderr"),
        "nm_symbols": [],
        "forbidden": [],
        "link_ok": os.path.exists(f"{res}/link_rc") and rc(f"{res}/link_rc") == 0,
        "link_stderr": capped(f"{res}/link_stderr"),
        "tests": [],
    }
    if os.path.exists(f"{res}/nm_symbols"):
        out["nm_symbols"] = json.loads(read_text(f"{res}/nm_symbols"))
        out["forbidden"] = [s for s in read_text(f"{res}/forbidden").decode().split("\n") if s]
    if stage == "static":
        out["static_message"] = read_text(f"{res}/static").decode() or "forbidden construct: asm"
    if stage == "tests":
        ids = json.loads(read_text(f"{meta}/ids"))
        max_out = int(read_text(f"{meta}/max_output_bytes"))
        test_ms = int(read_text(f"{meta}/test_timeout_ms"))
        cpu_s = int(read_text(f"{meta}/test_cpu_s"))
        out["tests"] = [test_result(tid, f"{res}/t{i}", max_out, test_ms, cpu_s) for i, tid in enumerate(ids)]
    sys.stdout.write("\n" + json.dumps(out, separators=(",", ":")) + "\n")


def main(argv):
    cmd = argv[1]
    if cmd == "prepare":
        prepare(argv[2], argv[3])
    elif cmd == "nm_check":
        nm_check(argv[2], argv[3], argv[4])
    elif cmd == "asm_check":
        asm_check(argv[2], argv[3])
    elif cmd == "emit":
        emit(argv[2], argv[3], argv[4])
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv)

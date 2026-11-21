#!/bin/sh
# Sandbox runner (DESIGN.md §6.3). Reads /in (read-only), works in /work (tmpfs, exec).
# Prints exactly one RunnerOutput JSON object as the last line of stdout.
#
# STUB: WP1 implements compile A, compile B + nm, link, and the per-test loop
# (setsid + timeout -s KILL, ulimit -t/-s, head -c max+1, process-group kill).
# python3-minimal is in the image for JSON and base64 handling; replace it if you prefer.
set -eu
cp -r /in/. /work/ 2>/dev/null || true
printf '%s\n' '{"runner_version":"stub","stage":"compile","compile_ok":false,"compile_stderr":"runner not implemented yet (WP1)","nm_symbols":[],"forbidden":[],"link_ok":false,"link_stderr":"","tests":[]}'

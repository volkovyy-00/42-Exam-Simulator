#!/bin/sh
# Sandbox runner (DESIGN.md §6.3). Reads /in (read-only), works in /work (tmpfs, exec).
# Prints exactly one RunnerOutput JSON object as the last line of stdout.
#
# The runner never sees expected output: /in holds the student file, the harness main/headers,
# allow.txt and job.json only. It reports raw bytes, exit status and flags; the dispatcher
# compares. argv values from job.json are passed with "set --", never through eval or a shell
# command line. python3 (runner_lib.py) only parses job.json and assembles the output JSON.
set -u
umask 077

LIB=/usr/local/lib/grader/runner_lib.py
META=/tmp/meta
RES=/tmp/res
STDERR_CAP=16384

py() { python3 -I "$LIB" "$@"; }

# Emit a RunnerOutput from what is on disk and stop. $1 = last stage reached.
finish() {
	py emit "$1" "$META" "$RES"
	exit 0
}

die_internal() {
	# Should never happen: report it as a compile failure so the student sees something,
	# and the dispatcher logs it.
	mkdir -p "$RES"
	printf 'runner error: %s\n' "$1" > "$RES/compile_stderr"
	echo 1 > "$RES/compile_rc"
	finish compile
}

# 1. Copy /in to /work. A failed copy fails the job; it is never ignored.
cd /work || die_internal "cannot cd /work"
if ! cp -r /in/. /work/ 2> /tmp/cp_err; then
	die_internal "cannot copy /in to /work: $(head -c 2000 /tmp/cp_err)"
fi
mkdir -p "$META" "$RES" || die_internal "cannot create /tmp dirs"
py prepare /work/job.json "$META" 2> /tmp/prep_err || die_internal "bad job.json: $(head -c 2000 /tmp/prep_err)"

KIND=$(cat "$META/kind")
STUDENT=$(cat "$META/student_file")
COMPILE_T=$(cat "$META/compile_timeout_s")
TEST_MS=$(cat "$META/test_timeout_ms")
TEST_CPU=$(cat "$META/test_cpu_s")
MAX_OUT=$(cat "$META/max_output_bytes")
NTESTS=$(cat "$META/ntests")
HAS_MAIN=$(cat "$META/has_main")

# Newline-separated cflags_extra from job.json (trusted content, validated by runner_lib).
CFLAGS_EXTRA=$(cat "$META/cflags")

# cc -Wall -Wextra -Werror <cflags_extra> "$@" under the compile timeout.
# $1 = result name: stderr goes to $RES/$1.err, the exit status to $RES/$1.rc.
compile() {
	name=$1
	shift
	(
		IFS='
'
		set -f
		# shellcheck disable=SC2086 # split on newlines only, globbing off
		exec timeout -s KILL "$COMPILE_T" cc -Wall -Wextra -Werror $CFLAGS_EXTRA "$@"
	) > /dev/null 2> "$RES/$name.err"
	echo $? > "$RES/$name.rc"
}

# 2. Compile A.
compile compile_a -c "$STUDENT" -o student.o
cp "$RES/compile_a.err" "$RES/compile_stderr"
cp "$RES/compile_a.rc" "$RES/compile_rc"
[ "$(cat "$RES/compile_rc")" = 0 ] || finish compile

# 3. Compile B (-fno-builtin) and nm -u on the student object only.
compile compile_b -fno-builtin -c "$STUDENT" -o student_nm.o
if [ "$(cat "$RES/compile_b.rc")" != 0 ]; then
	cp "$RES/compile_b.err" "$RES/compile_stderr"
	cp "$RES/compile_b.rc" "$RES/compile_rc"
	finish compile
fi
if ! nm -u student_nm.o > "$RES/nm_raw" 2> "$RES/nm.err"; then
	cp "$RES/nm.err" "$RES/compile_stderr"
	echo 1 > "$RES/compile_rc"
	finish compile
fi
# runner_lib strips the leading "_" and compares with allow.txt.
py nm_check "$RES/nm_raw" /work/allow.txt "$RES"
[ -s "$RES/forbidden" ] && finish nm

# 4. Link: student.o alone (program) or + harness main.c compiled with the same flags.
LINK_OBJS=student.o
if [ "$KIND" = function ] && [ "$HAS_MAIN" = 1 ]; then
	compile harness_main -c main.c -o harness_main.o
	if [ "$(cat "$RES/harness_main.rc")" != 0 ]; then
		{ echo "harness main.c failed to compile:"; cat "$RES/harness_main.err"; } > "$RES/link_stderr"
		echo 1 > "$RES/link_rc"
		finish link
	fi
	LINK_OBJS="student.o harness_main.o"
fi
# shellcheck disable=SC2086 # LINK_OBJS holds fixed, known names
timeout -s KILL "$COMPILE_T" cc $LINK_OBJS -o a.out > /dev/null 2> "$RES/link_stderr"
echo $? > "$RES/link_rc"
[ "$(cat "$RES/link_rc")" = 0 ] || finish link

# 5. Tests. One process group per test: setsid makes the test its own session and group
# leader, timeout -s KILL kills the group at the wall deadline, and we kill the group again
# afterwards in case something forked and survived.
T_SEC="$((TEST_MS / 1000)).$(printf '%03d' $((TEST_MS % 1000)))"
LIMIT=$((MAX_OUT + 1))
i=0
while [ "$i" -lt "$NTESTS" ]; do
	td="$META/t$i"
	rd="$RES/t$i"
	mkdir -p "$rd"
	if [ -f "$td/stdin" ]; then IN="$td/stdin"; else IN=/dev/null; fi
	n=$(cat "$td/argc")

	start=$(date +%s%N)
	(
		set --
		j=0
		while [ "$j" -lt "$n" ]; do
			# printf x keeps trailing newlines that $(...) would strip.
			a=$(cat "$td/arg$j"; printf x)
			set -- "$@" "${a%x}"
			j=$((j + 1))
		done
		ulimit -t "$TEST_CPU"
		ulimit -s 8192
		setsid timeout -s KILL "$T_SEC" ./a.out "$@" < "$IN" 2> /dev/null &
		pg=$!
		echo "$pg" > "$rd/pgid"
		wait "$pg"
		echo $? > "$rd/rc"
		kill -s KILL -- "-$pg" 2> /dev/null
	) | head -c "$LIMIT" > "$rd/out"
	end=$(date +%s%N)
	# The writer may still be alive if head exited first: kill its group.
	[ -f "$rd/pgid" ] && kill -s KILL -- "-$(cat "$rd/pgid")" 2> /dev/null
	echo $(((end - start) / 1000000)) > "$rd/ms"
	[ -f "$rd/rc" ] || echo 137 > "$rd/rc"
	i=$((i + 1))
done
finish tests

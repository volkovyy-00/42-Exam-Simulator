# Deploy checklist: Raspberry Pi 5 (arm64)

Run these steps in order, once per fresh install. Background is in [README.md](README.md),
DESIGN.md §0 and §10, and the integration list at the end of [TASKS.md](TASKS.md).
Tick each box as you go.

## 1. Host

- [ ] **Memory cgroup.** Append ` cgroup_enable=memory` to the single line in
      `/boot/firmware/cmdline.txt`, then reboot. After the reboot, `docker info` must print no
      memory-limit warning. If it does, `--memory` is silently ignored and the dispatcher
      refuses to start.
- [ ] **Kernel patched for GhostLock (CVE-2026-43499).** Run `sudo apt update && sudo apt full-upgrade`,
      then reboot. Check that the running kernel (`uname -r`) is one your distribution's
      advisory lists as fixed. Stay on the default kernel: do not switch to `kernel8.img`.
- [ ] **Docker with the compose plugin.** `docker compose version` works, and your user can run
      `docker` without sudo (it is in the `docker` group).
- [ ] **Node ≥ 22.18 on the host.** `node --version` must print at least v22.18. The content
      scripts and the grader tests run on the host, and they run `.ts` files directly.
- [ ] **Directories.** Run `sudo mkdir -p /srv/grader/jobs`, then
      `mkdir -p data && sudo chown 1000:1000 data` in the repo. The `web` container runs as
      uid 1000.
- [ ] **RAM.** Run `free -h`. The budget is 2 graders × 256 MiB, web 512 MiB and dispatcher
      192 MiB (DESIGN §0 row 8).

## 2. Build

- [ ] Clone the repo, then run `npm ci && npm run check`. It must pass on the Pi too.
- [ ] Copy the example config with `cp .env.example .env`. In `.env`, set `SESSION_SECRET` to
      32 random bytes, for example from `openssl rand -hex 32`. Leave `HINTS_ENABLED=false`
      unless you also set `OPENROUTER_API_KEY`.
- [ ] Build the images with `docker compose --profile build build`. This also builds the
      `grader:pinned` sandbox.
- [ ] Run `docker run --rm grader:pinned cc --version`. If the output differs from the line in
      the README's "Grader toolchain" section, update that line.
- [ ] Run `docker compose config`. Check that neither `OPENROUTER_API_KEY` nor
      `SESSION_SECRET` appears under `grader-dispatcher`.

## 3. Grader tests (real Docker)

- [ ] `npm run test:grading -w grader/dispatcher` passes. It runs the unit tests plus the
      grading tests on the real `grader:pinned` image, with `fixtures/` as content.

## 4. Content (private, never committed)

- [ ] Clone the seed: `git clone https://github.com/tomascoutotech/42-piscine-exam-trainer ~/seed`.
- [ ] Import it with `npm run content:import -- ~/seed`. Note the seed commit it records and
      the exercise count (73 expected over levels 0–5).
- [ ] Regenerate expected outputs in `grader:pinned` with `npm run content:regen`. Read
      `content/regen-diff.log`: every difference should be explained or fixed.
- [ ] Validate with `npm run content:check`. It must report N/73 references passing. Review the
      printed toolchain ignore list.
- [ ] Build the hint fingerprints with `npm run content:fingerprint`.
- [ ] Confirm nothing leaked into git: `git status` is clean, and `git ls-files content/`
      prints only `content/README.md`.

## 5. Start

- [ ] Start the services with `docker compose up -d`. After about 30 s, `docker compose ps`
      shows both `web` and `grader-dispatcher` as healthy.
- [ ] Run `curl -s http://127.0.0.1:8042/api/health`. It must show `"grader":"up"` and the
      exercise count from step 4.
- [ ] Publish over Tailscale with `sudo tailscale serve --bg 8042`, then open
      `https://<pi>.<tailnet>.ts.net` from a phone on the tailnet.
- [ ] Set the Tailscale ACL so the group can reach the Pi on 443 and the Pi cannot initiate
      connections to other tailnet devices.
- [ ] If you change `content/` later, reload it without a restart:
      `docker compose kill -s SIGHUP web grader-dispatcher`.

## 6. Users

- [ ] Create the first admin with `docker compose exec web node api/scripts/admin.ts create <username>`.
      It prompts for the password (10–200 characters).
- [ ] Create invites for friends with
      `docker compose exec web node api/scripts/admin.ts invite --count 3`. Each code is single
      use and valid for 7 days by default (`--days N` changes that).

## 7. Phone checks (record the results in the deploy notes or a PR)

Do these on **iPhone Safari** and on **Android with GBoard**, over the Tailscale URL:

- [ ] Tap each key-bar key 20×. Each tap inserts exactly once, and the keyboard stays open.
- [ ] Type `ft_putch`, then `(`.
- [ ] Accept an autocomplete suggestion by tap, then by Enter.
- [ ] Focus every input (login, register, editor). None of them zooms the page.
- [ ] Open and close the keyboard 5×. The Grade bar stays right above the keyboard each time.
- [ ] Tap Grade, and grademe in an exam. Each opens or runs exactly once, and the grademe
      confirm dialog stays open.
- [ ] If GBoard doubles or drops characters, or Enter misbehaves, set
      `localStorage.cm_edit_context = "off"`, reload, and repeat the Android checks.

## 8. End to end

- [ ] Register with an invite on a phone.
- [ ] Solve `gym_echo_first`, then fail it once on purpose and check the `cat -e` diff.
- [ ] Start a Piscine exam and pass slot 0.

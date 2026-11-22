# Deploy checklist: Raspberry Pi 4 (arm64, 1.8 GiB RAM)

Run these steps in order, once per fresh install. Background is in [README.md](README.md),
DESIGN.md §0 and §10, and the integration list at the end of [TASKS.md](TASKS.md).
Tick each box as you go.

## 1. Host

Steps 1a to 1d end in **one** reboot. Do them all, reboot once, then check everything in 1e.

- [ ] **1a. Memory cgroup.** Append ` cgroup_enable=memory` to the single line in
      `/boot/firmware/cmdline.txt`. Do not reboot yet.
- [ ] **1b. Spare copy of the current kernel.** Before upgrading, keep the kernel that boots
      today on the boot partition:

      ```sh
      sudo cp /boot/firmware/kernel8.img /boot/firmware/kernel8-old.img
      sudo cp /boot/firmware/initramfs8  /boot/firmware/initramfs8-old
      ```

      If there is no `initramfs8`, skip that copy and leave out the `initramfs` line below.
      If the upgraded kernel does not boot, put the SD card in another machine and add these
      two lines at the end of `config.txt` on the boot partition, then boot and investigate:

      ```
      kernel=kernel8-old.img
      initramfs initramfs8-old followkernel
      ```

      Do not run `apt autoremove` until the new kernel has booted cleanly, or the old
      kernel's modules in `/lib/modules` are gone. Delete the two lines (and the `-old` copies,
      if you like) once the new kernel is confirmed good.
- [ ] **1c. Full upgrade, outside your SSH session.** Upgrading the `tailscale` package restarts
      `tailscaled`. If you are connected over Tailscale SSH, that drops your session and a
      foreground `apt` dies with it, half way through `dpkg`. Run the upgrade as its own systemd
      unit so it survives:

      ```sh
      sudo apt update
      sudo systemd-run --unit=full-upgrade --setenv=DEBIAN_FRONTEND=noninteractive \
        apt-get -y -o Dpkg::Options::=--force-confold full-upgrade
      journalctl -fu full-upgrade      # Ctrl-C only stops watching; the upgrade keeps going
      ```

      Wait until `systemctl is-active full-upgrade` prints `inactive` (not `activating` or
      `failed`) and the journal ends without errors. If it printed `failed`, read
      `journalctl -u full-upgrade`, fix the cause, and run `sudo dpkg --configure -a` before
      trying again.
- [ ] **1d. Reboot once.** `sudo reboot`. This one reboot picks up both the cmdline change and
      the new kernel.
- [ ] **1e. Check after the reboot.**
      - `docker info` prints no memory-limit warning. If it does, `--memory` is silently
        ignored and the dispatcher refuses to start.
      - `uname -r` shows the new kernel, and `getconf PAGESIZE` prints `4096`. Stay on the
        default Pi 4 kernel (`kernel8.img`).
- [ ] **1f. Kernel patched for GhostLock (CVE-2026-43499): check the source, not the
      changelog.** A package changelog can omit a CVE, or name one whose fix is not in the build
      you are running. Check the kernel source instead:
      1. From the CVE record, note the **mainline commit** that fixes it.
      2. Get the source of the kernel you are running: the `raspberrypi/linux` tree at the
         commit your kernel package was built from (or `apt source` for that package).
      3. In that tree, run `git log -1 --oneline --grep=<mainline-sha>`. Stable backports quote
         the mainline ID (`commit <sha> upstream`), so a hit means the fix is in. With a tarball
         instead of git, open the file the fix changes and check the patched lines are there.

      If the fix is missing, do not open the app to users until a fixed kernel is installed.
- [ ] **Docker with the compose plugin.** `docker compose version` works, and your user can run
      `docker` without sudo (it is in the `docker` group).
- [ ] **Node ≥ 22.18 on the host.** `node --version` must print at least v22.18. The content
      scripts and the grader tests run on the host, and they run `.ts` files directly.
- [ ] **Directories.** Run `sudo mkdir -p /srv/grader/jobs`, then
      `mkdir -p data && sudo chown 1000:1000 data` in the repo. The `web` container runs as
      uid 1000.
- [ ] **RAM.** Run `free -h`. The app's worst case is 832 MiB: 1 grader sandbox × 256 MiB, web
      320 MiB and dispatcher 256 MiB (DESIGN §0 row 8). Everything else on the Pi has to fit in
      the rest of the 1.8 GiB.

## 2. Build

- [ ] Clone the repo, then run `npm ci && npm run check`. It must pass on the Pi too.
- [ ] Copy the example config with `cp .env.example .env`. In `.env`, set `SESSION_SECRET` to
      32 random bytes, for example from `openssl rand -hex 32`. Leave `HINTS_ENABLED=false`
      unless you also set `OPENROUTER_API_KEY`.
- [ ] Leave `GRADER_CONCURRENCY=1` in `.env` (the example's value). Two sandboxes do not fit
      in the Pi 4's memory budget; raise it to 2 only on a 4 GB+ host.
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
- [ ] **Publish over Tailscale on its own port, 8443.** First run `tailscale serve status`. If
      anything already serves `:443` (n8n does on this Pi), **do not take 443**: a plain
      `tailscale serve --bg 8042` or `--https=443` replaces that handler and breaks the other
      service. Publish the app on 8443 instead:

      ```sh
      sudo tailscale serve --bg --https=8443 http://127.0.0.1:8042
      tailscale serve status           # :443 unchanged, :8443 -> http://127.0.0.1:8042
      ```

      Then open `https://<pi>.<tailnet>.ts.net:8443` from a phone on the tailnet.
- [ ] **Tailscale ACL with `tag:pi`.** Tag the Pi `tag:pi` (admin console → Machines → the Pi →
      Edit ACL tags). Then let the group reach the app on 8443 and give the Pi no rule as a
      source, so it cannot initiate connections to other tailnet devices. Example policy (merge
      it into yours; keep any rules other services on the Pi, such as n8n on 443, still need):

      ```jsonc
      {
        "tagOwners": {
          "tag:pi": ["autogroup:admin"],
        },
        "groups": {
          "group:gym": ["friend1@example.com", "friend2@example.com"],
        },
        "acls": [
          // Friends: the exam app only.
          { "action": "accept", "src": ["group:gym"], "dst": ["tag:pi:8443"] },
          // Admins: everything on the Pi (SSH, n8n, ...).
          { "action": "accept", "src": ["autogroup:admin"], "dst": ["tag:pi:*"] },
          // No rule has tag:pi as src, so the Pi cannot open connections to other devices.
        ],
      }
      ```

      If your policy still has the default allow-all rule, remove it, or it overrides all of
      the above.
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

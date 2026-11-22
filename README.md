# C Exam Gym

Private, self-hosted trainer for the 42 Piscine C exam: a phone-friendly editor, 42-style
grading in a throwaway container per submission, exam and practice modes, and optional AI hints.
For a handful of friends over Tailscale; not public.

> Independent practice tool. Not affiliated with, endorsed by, or reflective of the official
> exams of 42 / École 42.

- **Design and API contract:** [DESIGN.md](DESIGN.md)
- **Remaining work, split into 4 packages:** [TASKS.md](TASKS.md)
- **Status:** scaffold. Every endpoint exists as a stub that matches the contract
  (responses carry `x-stub: 1`). Grading is not implemented yet.

Until grading works, drill for the exam with the seed's CLI
(`tomascoutotech/42-piscine-exam-trainer`, `./exam`).

## Develop

Node ≥ 22.18 (runs the backend's `.ts` files directly; no build step).

```sh
npm install
npm run check                      # typecheck + tests + SPA build
CONTENT_DIR=./fixtures COOKIE_SECURE=false npm run dev:api        # :8042
CONTENT_DIR=./fixtures npm run dev:dispatcher                     # :9000
npm run dev:web                    # :5173, proxies /api to :8042
```

`fixtures/` holds two original exercises in the same layout as `content/`.
`content/` (the imported 42-derived pool) is git-ignored: subject texts are © 42.

## Run locally (laptop, no Pi)

Runs the full app (web + grader in Docker) on macOS, Linux or Windows. Skip everything
Pi-specific: `cmdline.txt` / `cgroup_enable=memory`, the kernel upgrade and GhostLock check,
and Tailscale. You open the app on `localhost` instead.

**You need:** Git, Node ≥ 22.18 (`node --version`), and Docker with the compose plugin
(`docker compose version`): Docker Desktop on macOS and Windows, Docker Engine on Linux. On
Windows, use WSL 2 with Docker Desktop's WSL integration turned on, and run every command below
inside your WSL distro (for example Ubuntu), in a folder under your WSL home, not under `/mnt/c`.

**1. Clone.** The repo is private, so you need access to it (ask the owner to add you as a
collaborator) and a signed-in Git. Either works:

```sh
git clone git@github.com:volkovyy-00/42-exam-simulator.git     # SSH key added to GitHub
gh repo clone volkovyy-00/42-exam-simulator                    # or: gh auth login first
cd 42-exam-simulator
```

A plain `https://` clone also works if Git has a credential for it (a personal access token or
`gh auth setup-git`); without one it asks for a password and fails.

**2. Install and check.**

```sh
npm ci
npm run check                      # typecheck + tests + SPA build
```

**3. Config.**

```sh
cp .env.example .env
```

In `.env`, set `SESSION_SECRET` (for example the output of `openssl rand -hex 32`) and set
`COOKIE_SECURE=false`: there is no HTTPS locally, and some browsers drop a secure cookie over
plain `http://`, so you could not stay logged in. You can raise `GRADER_CONCURRENCY` to `2` on a
laptop. Leave `HINTS_ENABLED=false` unless you also set `OPENROUTER_API_KEY`.

**4. Jobs folder.** The dispatcher shares each submission with the sandbox through a host folder
that must have the same path on the host and in the container.

- *Linux (Docker Engine):* `sudo mkdir -p /srv/grader/jobs`, as on the Pi.
- *macOS and Windows (Docker Desktop):* `/srv` cannot be created on macOS and is not shared with
  Docker Desktop, so move the folder under your home. Run `mkdir -p ~/.c-exam-gym/jobs` and
  create `docker-compose.override.yml` next to `docker-compose.yml` (compose loads it
  automatically; it is for your machine only, don't commit it):

  ```yaml
  services:
    grader-dispatcher:
      environment:
        JOBS_DIR: ${HOME}/.c-exam-gym/jobs
      volumes: !override
        - /var/run/docker.sock:/var/run/docker.sock
        - ./content:/content:ro
        - ${HOME}/.c-exam-gym/jobs:${HOME}/.c-exam-gym/jobs
  ```

  `!override` needs Docker Compose 2.24 or newer.

**5. Build the images** (also builds the `grader:pinned` sandbox):

```sh
docker compose --profile build build
mkdir -p data
sudo chown 1000:1000 data          # Linux and WSL: web runs as uid 1000. Not needed on macOS.
```

**6. Content.** `content/` starts empty (it is git-ignored, see [Licence](#licence)). Import the
exercise pool from the seed trainer, then regenerate and validate it in `grader:pinned`:

```sh
git clone https://github.com/tomascoutotech/42-piscine-exam-trainer ../seed
npm run content:import -- ../seed  # 73 exercises over levels 0–5 expected
npm run content:regen              # read content/regen-diff.log
npm run content:check              # should report N/73 references passing
```

The seed path is any local clone of the trainer; `../seed` is just an example. To try the app
quickly without the seed, copy the two original test exercises instead:
`cp -R fixtures/manifest.json fixtures/exercises fixtures/harness fixtures/refs content/`
(leave `content/README.md` alone; it is the one tracked file there).

**7. Start.**

```sh
docker compose up -d
docker compose ps                  # after ~30 s: web and grader-dispatcher healthy
curl -s http://127.0.0.1:8042/api/health   # "grader":"up" and the exercise count
```

Open <http://localhost:8042>. The port is bound to `127.0.0.1` only, so other devices on your
network can't reach it.

**8. First user.** Create an admin (it prompts for a 10–200 character password), then invite
codes for anyone else using this instance:

```sh
docker compose exec web node api/scripts/admin.ts create <username>
docker compose exec web node api/scripts/admin.ts invite --count 3
```

Stop with `docker compose down`; your users and progress stay in `data/`. After changing
`content/`, reload it with `docker compose kill -s SIGHUP web grader-dispatcher`. After a
`git pull`, rebuild with `docker compose --profile build build` and run `docker compose up -d`
again.

## Deploy on the Pi

The full checklist is [DEPLOY.md](DEPLOY.md). Host prerequisites, once:

1. Append `cgroup_enable=memory` to `/boot/firmware/cmdline.txt`, reboot, and check that
   `docker info` prints no memory-limit warning. Without it `--memory` is silently ignored.
2. `sudo apt full-upgrade` and reboot; confirm the kernel has the GhostLock (CVE-2026-43499) fix.
3. `sudo mkdir -p /srv/grader/jobs`.
4. Tailscale ACL: the Pi (`tag:pi`) accepts 8443 from the group, and cannot initiate connections to other
   tailnet devices.
5. Stay on the default Pi 4 kernel (`kernel8.img`). gVisor is out of scope (39-bit VA).
6. Optional: `hyperfine --warmup 3 'docker run --rm --network none alpine true'` to measure
   container start time.

Then:

```sh
cp .env.example .env               # set SESSION_SECRET
docker compose --profile build build
mkdir -p data && sudo chown 1000:1000 data   # SQLite; web runs as uid 1000
docker compose up -d
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8042   # https://<pi>.<tailnet>.ts.net:8443
```

## Licence

Code: MIT. Exercise statements imported into `content/` belong to 42 / École 42 and stay private.
The seed's code, tests and solutions are MIT © 2026 Tomas Couto (kept in `content/LICENSE-seed`).

## Grader toolchain (`grader:pinned`)

Every submission is compiled with the image's `cc` (Debian trixie `gcc-14`). Print it with:

```sh
docker run --rm grader:pinned cc --version
```

```
cc (Debian 14.2.0-19) 14.2.0
```

Confirmed by running the command above on the Pi 4 after `docker compose --profile build build`
(Debian trixie's `gcc-14` package, 14.2.0-19). If a rebuild prints a different line, update it here.

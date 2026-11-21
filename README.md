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

## Deploy on the Pi

Host prerequisites, once:

1. Append `cgroup_enable=memory` to `/boot/firmware/cmdline.txt`, reboot, and check that
   `docker info` prints no memory-limit warning. Without it `--memory` is silently ignored.
2. `sudo apt full-upgrade` and reboot; confirm the kernel has the GhostLock (CVE-2026-43499) fix.
3. `sudo mkdir -p /srv/grader/jobs`.
4. Tailscale ACL: the Pi accepts 443 from the group, and cannot initiate connections to other
   tailnet devices.
5. Do not switch to `kernel8.img`. gVisor is out of scope (16K pages).
6. Optional: `hyperfine --warmup 3 'docker run --rm --network none alpine true'` to measure
   container start time.

Then:

```sh
cp .env.example .env               # set SESSION_SECRET
docker compose --profile build build
docker compose up -d
sudo tailscale serve --bg 8042     # https://<pi>.<tailnet>.ts.net
```

## Licence

Code: MIT. Exercise statements imported into `content/` belong to 42 / École 42 and stay private.
The seed's code, tests and solutions are MIT © 2026 Tomas Couto (kept in `content/LICENSE-seed`).

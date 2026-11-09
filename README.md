# Ivorist toolchain

Discord-driven ops for the Ivorist site: submissions and deployments flow
from Discord through a Cloudflare gateway into a local runner daemon that
executes jobs on this machine.

```
Discord (channels / slash commands)
        │  events + interactions
        ▼
ivorist-gateway (Cloudflare Worker + Durable Object)
        │  KV job queue  ·  R2 artifact store  ·  live status embeds
        ▼
runner daemon (this PC, this OpenCode session)
        │  rules  ·  secret scan/rewrite  ·  git  ·  wrangler deploys
        ▼
ivorists.com  ·  <app>.ivorists.com  ·  github.com/JHPate1/ivorist
```

The bot is served 24/7 by the Cloudflare Durable Object (gateway WebSocket),
so it answers and queues even when this PC is off. When the runner comes
back, queued jobs execute.

## Layout

- `worker/` — the Cloudflare gateway (`ivorist-gateway`)
  - `src/index.js` — interactions endpoint, runner API, cron re-queue
  - `src/gateway.js` — Durable Object holding the 24/7 gateway session
  - `src/jobs.js` — job store, embeds, Discord REST
- `../rules.js` — shared submission rules (worker and runner import it)
- `runner/` — local executor (zero npm deps)
  - `runner.js` — claim → artifact → rules → git → deploy → report loop
  - `register-commands.js` — registers the slash commands on the guild
  - `runner-config.json` — local runtime config (gitignored)

## Channels

| Channel id | Purpose | Command / drop |
|---|---|---|
| `1569366033389588523` | deploy web app | `/create` or drop a zip |
| `1569366921961545780` | submit project to site | `/project` or drop a zip |
| `1569367133685678182` | submit change to site | `/change` or drop a zip |
| `1569367283879387346` | Ivorist Bank | reserved (responds "coming soon") |

## Commands

- `/create subdomain name description zip` — builds a web app. Strict rules:
  - subdomain: `3-32` chars, lowercase letters/numbers/hyphens; no reserved names
  - zip root must have `index.html` (static) or `worker.js` (worker app)
  - no own `wrangler.jsonc` (Ivorist generates the deploy config)
  - executables (`.exe`, `.bat`, `.ps1`, `.php`, …) are rejected
  - `.env` keys: safe ones become non-secret vars; anything sensitive must be
    consumed by a `worker.js`, whose code is rewritten
    `process.env.KEY → env.KEY`, and the value is bound as a Cloudflare secret.
    Static apps that contain sensitive keys are rejected outright.
  - each app deploys as `ivorist-app-<sub>` worker on `https://<sub>.ivorists.com`
    with an explicit zone route (the zone's `*.ivorists.com` catch-all is outranked)
- `/project name category summary zip` — new project page on the site

  - zip root needs `index.html`; the page lands at `projects/<slug>/index.html`
    and `projects.json` gets an entry (the site renders it dynamically)
  - branch `projects/<slug>` is pushed then merged to main; the site redeploys
- `/change summary zip` — patch of site files, mirrored onto repo paths
  - only whitelisted file types and no infra-owned files (`worker.js`,
    `wrangler.jsonc`, `.assetsignore`, `logo.png`, …)
- `/apps` — list deployed apps with URLs
- `/status [job_id]` — tracker for a job
- `/log` — last 10 jobs
- `/ping` — which parts are online
- `/bank` — Ivorist Bank placeholder response

Every job posts a public tracker embed in its channel and edits it live at
each pipeline step; rejections and failures post the reason back there too.

## Setup (once)

1. Deploy the gateway: `cd worker && npx wrangler deploy`
2. Provide Discord credentials as secrets:
   ```
   npx wrangler secret put DISCORD_TOKEN      # bot token
   npx wrangler secret put DISCORD_PUBLIC_KEY # app public key
   npx wrangler secret put RUNNER_TOKEN       # same value as runner-config.json
   npx wrangler deploy
   ```
3. Fill `runner/runner-config.json` (copy from `.example`), then register
   commands: `node register-commands.js` (needs `discordToken`,
   `discordApplicationId`, `discordGuildId` in the config or the env)
4. Invite the bot: use the developer portal OAuth2 URL with scopes
   `bot applications.commands` (view/send/attach/embed/manage messages).
5. Start the runner: `runner\start-runner.cmd` (or `node runner.js`).

## Failure modes

- Runner offline: jobs queue in Cloudflare KV; a 5-minute cron requeues
  jobs whose runner died mid-execution (2 attempts, then it fails loudly).
- 30 MB zip cap, 800 file cap, 3× extraction ratio cap, path traversal and
  duplicate-interaction guards on the worker side.
- Secrets never land in the git repo: `.env` files are consumed by the
  runner, values become Cloudflare secrets, code is rewritten before commit.

## Local test path (without Discord)

```
POST /runner/enqueue-test   (Bearer RUNNER_TOKEN, header X-Test-Job: JSON)
```
…with the zip as the raw body. This is how the pipeline was validated.

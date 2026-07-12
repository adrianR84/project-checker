# Project Checker

Backend server + Vue 3 SPA that monitors websites, GitHub repositories, Twitter accounts, and crypto token prices. Detects changes, records events, sends alerts via Telegram and Pushbullet, and surfaces everything in a web dashboard.

## Setup

```bash
pnpm install
pnpm start
```

Open [http://localhost:3000](http://localhost:3000).

For live reload during development:

```bash
pnpm dev      # starts Express + live-reload server
pnpm dev:log  # same, but also saves output to logs/output.log
pnpm dev | pnpm log:pipe  # same as pnpm dev:log
```

## What it does

| Resource | What it checks |
|----------|----------------|
| Website | HTTP status, response time, content fingerprint (title, Open Graph, Twitter tags, canonical, first paragraph) — detects page changes |
| GitHub | New commits, new tags, deleted repos — per-org via GitHub API |
| Twitter / X | HTTP status, suspended-account detection via `defuddle` CLI |
| Token price | USD price, 1h/6h/24h change, liquidity, volume, market cap from DexScreener |

Changes are recorded as events in `event_logs` and alerted on configurable intervals via Telegram and/or Pushbullet.

## Project structure

```
project-checker/
├── index.js              # Express entry point
├── package.json
├── data/
│   └── project-checker.db  # SQLite database
├── services/
│   ├── db.js             # node:sqlite init, schema, promisified proxy
│   ├── checker.js        # checkWebsite, checkGithubRepo, checkTwitter, logCheck
│   ├── github.js         # GitHub API: repos, commits, tags (token from DB)
│   ├── scheduler.js       # node-cron jobs, alert dispatch, log purge
│   ├── notifications.js  # Telegram + Pushbullet alert sender
│   └── migrations.js     # Idempotent schema migrations (runs on every init)
├── routes/
│   ├── projects.js       # CRUD, manual checks, repo management
│   ├── dashboard.js      # Aggregated project status, token prices
│   ├── settings.js       # Config read/write, trigger-all, danger zone
│   └── checkLogs.js      # check_logs, event_logs, alert_logs endpoints
├── public/
│   ├── index.html        # Vue 3 SPA (CDN)
│   └── styles.css        # Pico CSS dark overrides + app tokens
├── utils/
│   ├── kill-ports.js
│   ├── dev-log.js
│   └── log-pipe.js
├── logs/
└── .env                  # PORT only (GitHub token is stored via the UI)
```

## Database

SQLite via Node.js built-in `node:sqlite`. Database file: `data/project-checker.db`.

Key tables:

- `projects` — name, URLs, enabled flags, token JSON, timestamps
- `repos` — linked GitHub repos per project with commit/tag state
- `check_logs` — per-check results: status, HTTP code, response time, content hash
- `event_logs` — status change events: changed, deleted, tag_changed, confirmed
- `alert_logs` — alert dispatch records (one row per fired alert)
- `token_prices` — DexScreener data per project: price, change %, liquidity, volume
- `config` — singleton row with JSON groups for all settings

## Settings

All settings are stored in the `config` table as JSON group columns:

| Group key | Contents |
|-----------|----------|
| `settings` | `log_retention_days`, `ui_refresh_seconds`, `compact_activity_display`, `github_token`, `logs_per_page` |
| `check_intervals` | `github`, `website`, `twitter` (minutes) |
| `alert_intervals` | `github`, `website`, `twitter` (minutes — 0 disables) |
| `alert_stops` | `github`, `website`, `twitter` (minutes — 0 = indefinite) |
| `telegram` | `bot_token`, `chat_id`, `enabled` |
| `pushbullet` | `access_token`, `enabled` |
| `price_alerts` | Array of alert slots with `price_change`, `price_interval`, `enabled`, `telegram`, `pushbullet`, `log` |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `SCHEDULER_DEBUG` | `0` | Set to `1` to enable verbose scheduler tick logging |
| `SKIP_AUTH` | — | Set to `true` to bypass authentication (dev mode only) |
| `DEFAULT_USER_ID` | — | User ID used by scheduler to read config when `SKIP_AUTH=true` |
| `BETTER_AUTH_URL` | — | OAuth callback origin (e.g. `http://localhost:3001`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth credentials |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub OAuth credentials |
| `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` | — | Twitter OAuth credentials |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | — | Facebook OAuth credentials |

## API

### Projects

- `GET /api/projects` — list all projects
- `GET /api/projects/:id` — single project with repos and latest check logs
- `POST /api/projects` — create project (runs website + Twitter checks immediately)
- `PUT /api/projects/:id` — update project (optionally sync repos array)
- `DELETE /api/projects/:id` — delete project (cascades to repos, logs)
- `GET /api/projects/:id/org-repos` — fetch all repos for the project's GitHub org
- `POST /api/projects/:id/refresh-repos` — re-fetch all repos, detect deletions
- `POST /api/projects/:id/add-repos` — upsert selected repos, initial check
- `DELETE /api/projects/:id/repos/:fullName` — remove a specific repo
- `POST /api/projects/:id/check-website` — manual website check
- `POST /api/projects/:id/check-github` — manual GitHub check (all active repos)
- `POST /api/projects/:id/check-twitter` — manual Twitter check

### Dashboard

- `GET /api/dashboard` — all enabled projects with latest check status per resource and last-change timestamps
- `GET /api/dashboard/token-prices` — all token prices joined with project names

### Check Logs

- `GET /api/check-logs` — paginated check_logs with project/repo join; filter by `project_id`, `resource_type`
- `GET /api/check-logs/status-changes` — paginated event_logs (unconfirmed events); filter by `project_id`, `resource_type`
- `PATCH /api/check-logs/status-changes/:id/confirm` — set `confirmed` 0/1
- `GET /api/check-logs/alerts` — paginated alert_logs; filter by `project_id`, `resource_type`

### Settings

- `GET /api/settings` — full config snapshot (flat + group shapes)
- `PUT /api/settings` — update check intervals, alert intervals/stops, log retention, UI refresh, GitHub token, notification channels, price alerts
- `POST /api/settings/trigger-all` — run all enabled checks for all projects
- `POST /api/settings/trigger-websites` — run website checks for all projects
- `POST /api/settings/trigger-github` — run GitHub checks for all projects
- `POST /api/settings/trigger-twitter` — run Twitter checks for all projects
- `POST /api/settings/clear-data` — delete all projects, repos, check_logs, event_logs (keeps config)
- `POST /api/settings/clear-logs` — delete check_logs, event_logs, alert_logs
- `POST /api/settings/clear-alert-logs` — delete alert_logs only

## Scheduler

Runs via `node-cron`. Expressions are recomputed from config on every change:

| Job | Default interval | What it does |
|-----|-----------------|--------------|
| Website tick | Every 1440 min (1 day) | GET each enabled website URL |
| GitHub tick | Every 360 min (6 hrs) | Fetch org repos, detect deletions, check each active repo |
| Twitter tick | Every 1440 min (1 day) | GET each Twitter URL, defuddle parse on 200 responses |
| Token price tick | Every 60 s (setInterval) | DexScreener batch fetch, upsert `token_prices` |
| Alert tick | Every 1 min (cron grid) | Fire Telegram/Pushbullet for unconfirmed events past their interval |
| Log purge | Daily at midnight | Delete `check_logs` older than `log_retention_days` |

## License

MIT

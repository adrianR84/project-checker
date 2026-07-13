# Project Checker

Backend server + Vue 3 SPA that monitors websites, GitHub repositories, Twitter accounts, and crypto token prices. Detects changes, records events, sends alerts via Telegram and Pushbullet, and surfaces everything in a web dashboard.

## Setup

```bash
pnpm install
pnpm start
```

Open [http://localhost:3004](http://localhost:3004).

For live reload during development:

```bash
pnpm dev      # starts Express + live-reload server
pnpm dev:log  # same, but also saves output to logs/output.log
pnpm dev | pnpm log:pipe  # same as pnpm dev:log
```

Maintenance utilities:

```bash
pnpm vacuum       # VACUUM the SQLite DB to reclaim unused pages
pnpm drop-tables  # DROP all data tables (schema gone — use to reset DB)
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
├── .env                  # Environment variables (PORT, auth, etc.)
├── data/
│   └── project-checker.db  # SQLite database
├── services/
│   ├── db.js             # node:sqlite init, schema, promisified proxy
│   ├── checker.js        # checkWebsite, checkGithubRepo, checkTwitter, logCheck
│   ├── github.js          # GitHub API: repos, commits, tags (token from DB)
│   ├── scheduler.js       # node-cron jobs, alert dispatch, log purge
│   ├── notifications.js   # Telegram + Pushbullet alert sender
│   ├── auth.js            # better-auth instance (social OAuth: Google, GitHub, Twitter, Facebook)
│   └── migrations.js      # Idempotent schema migrations (runs on every init)
├── routes/
│   ├── projects.js        # CRUD, manual checks, repo management
│   ├── dashboard.js       # Aggregated project status, token prices
│   ├── settings.js        # Config read/write, trigger-all, danger zone
│   └── checkLogs.js       # check_logs, event_logs, alert_logs endpoints
├── public/
│   ├── index.html         # Vue 3 SPA (CDN)
│   └── styles.css         # Pico CSS dark overrides + app tokens
├── utils/
│   ├── kill-ports.js      # Kill processes on ports 3004/3005
│   ├── dev-log.js         # Dev server wrapper with log file output
│   ├── log-pipe.js        # Pipe dev server output to log file
│   ├── vacuum-db.js        # SQLite VACUUM maintenance script
│   ├── drop-tables.js      # Drop all data tables
│   └── deploy.sh           # Deployment script
├── logs/
└── .env                   # Environment variables
```

## Database

SQLite via Node.js built-in `node:sqlite`. Database file: `data/project-checker.db`.

Key tables:

- `projects` — name, URL JSON cols (`website`, `github`, `twitter`, `telegram`, `token`), per-resource `*_enabled` flags, `enabled`, `user_id`, timestamps
- `repos` — linked GitHub repos per project with commit/tag state, `default_branch`, stars, language
- `check_logs` — per-check results: status, HTTP code, response time, content hash
- `event_logs` — status change events: `changed`, `deleted`, `tag_changed`, `confirmed`
- `alert_logs` — alert dispatch records (one row per fired alert)
- `token_prices` — DexScreener data per project: price, change %, liquidity, volume
- `config` — singleton row with JSON groups for all settings
- `token_prices_alerts` — price alert throttle (prevents duplicate alerts)

Indexes:

- `idx_projects_user_id` on `projects(user_id)`
- `idx_config_user_id` on `config(user_id)`
- `idx_check_logs_project_resource_date` on `check_logs(project_id, resource_type, checked_at)`
- `idx_event_logs_project_resource` on `event_logs(project_id, resource_type, created_at)`
- `idx_event_logs_alerting` on `event_logs(resource_type, confirmed, created_at)`
- `idx_alert_logs_status_change_id` on `alert_logs(status_change_id)`

## Settings

All settings are stored in the `config` table as JSON group columns:

| Group | Key | Description |
|-------|-----|-------------|
| `settings` | `log_retention_days` | Days to keep check logs (0 = keep all) |
| | `ui_refresh_seconds` | Auto-refresh interval for the Activity view |
| | `compact_activity_display` | Hide repositories section per project in Activity view |
| | `github_token` | GitHub personal access token for API calls |
| | `logs_per_page` | Logs per page for Events, Check Logs, Alert Logs |
| | `checks_on_new_project` | Run checks immediately when adding/importing a project (1 = on, 0 = off) |
| `check_intervals` | `github`, `website`, `twitter` | Check interval in minutes |
| `alert_intervals` | `github`, `website`, `twitter` | Alert delay in minutes (0 = disable) |
| `alert_stops` | `github`, `website`, `twitter` | Stop alerting after N minutes (0 = indefinite) |
| `telegram` | `bot_token`, `chat_id`, `enabled` | Telegram bot configuration |
| `pushbullet` | `access_token`, `enabled` | Pushbullet configuration |
| `price_alerts` | Array of alert slots | Price change thresholds with `price_change`, `price_interval`, `enabled`, `telegram`, `pushbullet`, `log` |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3004` | Server port |
| `SCHEDULER_DEBUG` | `0` | Set to `1` to enable verbose scheduler tick logging |
| `SKIP_AUTH` | — | Set to `true` to bypass authentication (dev mode only) |
| `DEFAULT_USER_ID` | — | User ID used by scheduler and auth bypass when `SKIP_AUTH=true` |
| `BETTER_AUTH_URL` | — | OAuth callback origin (e.g. `http://localhost:3001`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth credentials |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub OAuth credentials |
| `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` | — | Twitter OAuth credentials |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | — | Facebook OAuth credentials |

## API

### Projects

- `GET /api/projects` — list all projects
- `GET /api/projects/:id` — single project with repos and latest check logs
- `POST /api/projects` — create project; optionally runs website + Twitter checks immediately (gated by `checks_on_new_project` setting)
- `PUT /api/projects/:id` — update project (optionally sync repos array)
- `DELETE /api/projects/:id` — delete project (cascades to repos, logs)
- `GET /api/projects/:id/org-repos` — fetch all repos for the project's GitHub org
- `POST /api/projects/:id/refresh-repos` — re-fetch all repos, detect deletions
- `POST /api/projects/:id/add-repos` — upsert selected repos; optionally runs GitHub check per repo (gated by `checks_on_new_project` setting)
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
- `PUT /api/settings` — update check intervals, alert intervals/stops, log retention, UI refresh, GitHub token, notification channels, price alerts, `checks_on_new_project`
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
| Token price tick | Every 60 s | DexScreener batch fetch, upsert `token_prices` |
| Alert tick | Every 1 min (cron grid) | Fire Telegram/Pushbullet for unconfirmed events past their interval |
| Log purge | Daily at midnight | Delete `check_logs` older than `log_retention_days` |

## License

MIT

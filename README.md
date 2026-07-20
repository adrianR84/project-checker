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
pnpm dev         # Express + live-reload frontend (port 3005)
pnpm dev:see-me  # dev + browser activity monitoring via `see-me 3004`
pnpm dev:log     # dev, with output saved to logs/output.log   same as "pnpm dev | pnpm log:pipe"
pnpm see-me      # kill ports, start server, monitor browser at `see-me 3004`
```

Maintenance utilities:

```bash
pnpm vacuum       # VACUUM the SQLite DB to reclaim unused pages
pnpm drop-tables  # DROP all data tables (schema gone — use to reset DB)
```

## What it does

Monitors websites, GitHub orgs/repos, Twitter/X accounts, and crypto token prices for changes. Sends alerts via Telegram and/or Pushbullet on configurable intervals, with auto-stop after a grace period.

| Resource | What it checks |
|----------|----------------|
| Website | HTTP status, response time, content fingerprint (title, Open Graph, Twitter tags, canonical, first paragraph) — detects page changes |
| GitHub | New commits, new tags, deleted repos — per-org via GitHub API; supports adding individual repos to a project |
| Twitter / X | HTTP status, suspended-account detection via `defuddle` CLI; caches recent posts and detects new ones |
| Token price | USD price, 1h/6h/24h change, liquidity, volume, market cap from DexScreener |

Multi-user via `better-auth` (email/password + Google/GitHub/Twitter/Facebook OAuth). Projects can be bulk-imported via the public API v1 using a bearer token.

## Project structure

```
project-checker/
├── index.js                 # Express entry point
├── package.json
├── .env                    # Environment variables
├── .env.example            # Environment variable template
├── services/
│   ├── db.js               # node:sqlite init, schema, lazy proxy
│   ├── checker.js          # checkWebsite, checkGithubRepo, checkTwitter, logCheck
│   ├── github.js           # GitHub API: repos, commits, tags (token from DB)
│   ├── scheduler.js        # node-cron jobs, alert dispatch, log purge
│   ├── notifications.js    # Telegram + Pushbullet alert sender
│   ├── auth.js             # better-auth instance (Google, GitHub, Twitter, Facebook OAuth)
│   └── migrations.js       # Idempotent schema migrations (runs on every init)
├── routes/
│   ├── api.js              # /api/v1 — public bearer-token import (no session auth)
│   ├── projects.js         # CRUD, manual checks, repo management
│   ├── dashboard.js        # Aggregated project status, token prices
│   ├── checkLogs.js        # check_logs, event_logs, alert_logs endpoints
│   └── settings.js         # Config read/write, trigger-all, danger zone
├── public/
│   ├── index.html          # Vue 3 SPA (CDN)
│   └── styles.css          # Pico CSS dark overrides + app tokens
├── utils/
│   ├── kill-ports.js       # Kill processes on ports 3004/3005
│   ├── dev-log.js          # Dev server wrapper with log file output
│   ├── log-pipe.js         # Pipe dev server output to log file
│   ├── vacuum-db.js        # SQLite VACUUM maintenance script
│   ├── drop-tables.js      # Drop all data tables
│   └── deploy.sh           # Deployment script (SSH/SCP to VPS, pm2 restart)
├── data/
│   └── project-checker.db  # SQLite database
└── logs/
    └── output.log          # Captured dev-server stdout (last run)
```

## Database

SQLite via Node.js built-in `node:sqlite`. Database file: `data/project-checker.db`.

Key tables:

- `projects` — name, URL JSON cols (`website`, `github`, `twitter`, `telegram`, `token`), per-resource `*_enabled` flags, `enabled`, `user_id`, timestamps
- `repos` — linked GitHub repos per project with commit/tag state, `default_branch`, stars, language, `status`
- `check_logs` — per-check results: status, HTTP code, response time, error_message, details (JSON)
- `event_logs` — status change events: `changed`, `deleted`, `tag_changed`, `confirmed`
- `alert_logs` — alert dispatch records (one row per fired alert, keyed to `event_logs.id`)
- `twitter_posts` — cached tweet rows per project (post_id, author, link, content, published_at)
- `token_prices` — DexScreener data per project: price, change %, liquidity, volume, market cap
- `token_prices_alerts` — price alert throttle: `(project_id, price_change)` composite PK prevents duplicate alerts
- `config` — singleton row with JSON groups for all settings

Indexes:

- `idx_projects_user_id` on `projects(user_id)`
- `idx_config_user_id` on `config(user_id)`
- `idx_check_logs_project_resource_date` on `check_logs(project_id, resource_type, checked_at)`
- `idx_event_logs_project_resource` on `event_logs(project_id, resource_type, created_at DESC)`
- `idx_event_logs_alerting` on `event_logs(resource_type, confirmed, created_at DESC)`
- `idx_alert_logs_status_change_id` on `alert_logs(status_change_id, created_at DESC)`

## Settings

All settings are stored in the `config` table as JSON group columns:

| Group | Key | Default | Description |
|-------|-----|---------|-------------|
| `settings` | `log_retention_days` | `7` | Days to keep check logs (0 = keep all) |
| | `event_log_retention_days` | `14` | Days to keep event logs |
| | `alert_log_retention_days` | `14` | Days to keep alert logs |
| | `twitter_posts_per_project` | `50` | Max cached tweets per project (50–100) |
| | `ui_refresh_seconds` | `60` | Activity auto-refresh interval (0 = off) |
| | `compact_activity_display` | `0` | Hide repos section in Activity view |
| | `github_token` | `null` | GitHub PAT — raises rate limit 60→5000 req/hr |
| | `api_token` | `null` | Bearer token for public API v1 import |
| | `logs_per_page` | `20` | Pagination size for log endpoints (5–100) |
| | `checks_on_new_project` | `1` | Run checks immediately on project create/import |
| `check_intervals` | `github` | `360` | GitHub check interval in minutes |
| | `website` | `1440` | Website check interval in minutes |
| | `twitter` | `1440` | Twitter check interval in minutes |
| `alert_intervals` | `github` | `60` | Re-alert cadence in minutes (0 = disable) |
| | `website` | `60` | same |
| | `twitter` | `60` | same |
| `alert_stops` | `github` | `1440` | Stop alerting after N minutes (0 = indefinite) |
| | `website` | `1440` | same |
| | `twitter` | `1440` | same |
| `telegram` | `bot_token` | `''` | Telegram Bot API token |
| | `chat_id` | `''` | Telegram target chat ID |
| | `enabled` | `false` | Enable Telegram alerts |
| `pushbullet` | `access_token` | `''` | Pushbullet OAuth token |
| | `enabled` | `false` | Enable Pushbullet alerts |
| `price_alerts` | `alerts[]` | `[{price_change:10,price_interval:5,...}, {...25,...15}, {...50,...60}]` | Price change thresholds with throttle windows |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3004` | Server port |
| `LIVE_RELOAD_PORT` | `3005` | Live-reload dev server port |
| `SCHEDULER_DEBUG` | `0` | Set to `1` for verbose scheduler tick logging |
| `SHOW_DB_OPTIONS` | `0` | Enable extra DB operations in settings UI |
| `SKIP_AUTH` | — | Set to `1` to bypass authentication (dev mode only) |
| `DEFAULT_USER_ID` | — | Fallback user ID when `SKIP_AUTH=1` or scheduler has no session |
| `BETTER_AUTH_URL` | `http://localhost:3004` | OAuth callback origin — must match registered redirect URI |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth credentials |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | GitHub OAuth credentials |
| `TWITTER_CLIENT_ID` / `TWITTER_CLIENT_SECRET` | — | Twitter/X OAuth credentials |
| `FACEBOOK_CLIENT_ID` / `FACEBOOK_CLIENT_SECRET` | — | Facebook OAuth credentials |

Deploy script variables (in `utils/deploy.sh`):

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_INSTALL` | `1` | Skip `pnpm install` on remote |
| `SKIP_DATA` | `1` | Exclude `data/` from deployment tarball |
| `SKIP_ENV` | `1` | Exclude `.env` from deployment tarball |
| `DEPLOY_PM2` | `project-checker` | PM2 process name on VPS |

## API

### Authentication

All endpoints under `/api/*` (except `/api/v1/*` and `/api/auth/*`) require an active session cookie set by `better-auth`. In dev mode (`SKIP_AUTH=1`), all auth is bypassed and `DEFAULT_USER_ID` is used.

#### Auth endpoints (better-auth)

- `ANY /api/auth/*` — delegates to better-auth: social OAuth callbacks (Google, GitHub, Twitter, Facebook) and session management

### Public API v1 (bearer-token)

Mounted at `/api/v1`. Uses `Authorization: Bearer <api_token>` — no session cookie required.

- `POST /api/v1/projects/import` — import one or more projects from JSON body

  Single project: `{ name, symbol, contractAddress, chainId, website?, github?, twitter?, telegram? }`
  Multiple: array of objects

  Response:
  ```json
  { "created": [{ "index": 0, "id": 1, "name": "My Token", "created_at": "..." }],
    "errors": [{ "index": 1, "error": "Project with this name already exists" }] }
  ```

  Duplicate detection: a project is considered a duplicate when **all provided fields** (name, website, github, twitter, telegram, token) match an existing project for the same user. Fields not provided are ignored.

### Projects

- `GET /api/projects` — list all projects (newest first, user-scoped)
- `GET /api/projects/:id` — single project with `repos[]` and `latest_logs` per resource type
- `POST /api/projects` — create project; runs website + Twitter checks immediately if `checks_on_new_project=1`
- `PUT /api/projects/:id` — update project; optionally sync repos via `repos: [{ full_name, repo_url, ... }]`
- `DELETE /api/projects/:id` — delete project (cascades to repos, check_logs, event_logs)
- `GET /api/projects/:id/org-repos` — fetch all repos for the project's GitHub org
- `POST /api/projects/:id/refresh-repos` — re-fetch org repos, detect deletions, upsert with commit history
- `POST /api/projects/:id/add-repos` — upsert selected repos; optionally runs GitHub check per repo if `checks_on_new_project=1`
- `DELETE /api/projects/:id/repos/*` — remove a repo (`full_name` may contain `/`; path is wildcard)
- `POST /api/projects/:id/check-website` — manual website check
- `POST /api/projects/:id/check-github` — manual GitHub check (all active repos)
- `POST /api/projects/:id/check-twitter` — manual Twitter check
- `GET /api/projects/:id/twitter-posts` — cached tweets for the project (up to 100, newest first)

### Dashboard

- `GET /api/dashboard` — all enabled projects with latest check status per resource and last-change timestamps
- `GET /api/dashboard/token-prices` — all token prices joined with project names and URLs

### Check Logs

- `GET /api/check-logs` — paginated check_logs; filter by `project_id`, `resource_type`, `search`; max `limit=1000`
- `GET /api/check-logs/status-changes` — paginated `event_logs`; filter by `project_id`, `resource_type`, `search`
- `PATCH /api/check-logs/status-changes/:id/confirm` — set `confirmed` to `0` or `1`
- `POST /api/check-logs/status-changes/confirm-all` — bulk-confirm all unconfirmed events for the user
- `GET /api/check-logs/alerts` — paginated `alert_logs` with event details; filter by `project_id`, `resource_type`

### Settings

- `GET /api/settings` — full config snapshot (flat + group shapes); sensitive tokens masked to `DUMMY_TOKEN_*`
- `PUT /api/settings` — update any subset of: check/alert intervals, log retention, UI refresh, tokens, notification channels, price alerts
- `POST /api/settings/trigger-all` — run website + Twitter + GitHub checks for all owned projects
- `POST /api/settings/trigger-websites` — run website checks for all projects
- `POST /api/settings/trigger-github` — run GitHub checks for all active repos
- `POST /api/settings/trigger-twitter` — run Twitter checks for all projects
- `POST /api/settings/generate-api-token` — generate a new `PC_<hex>` API token (returns `{ api_token }`)
- `POST /api/settings/clear-data` — delete all projects, repos, check_logs, event_logs (keeps config)
- `POST /api/settings/clear-logs` — delete check_logs, event_logs, alert_logs for all owned projects
- `POST /api/settings/clear-alert-logs` — delete only alert_logs for all owned projects

## Scheduler

Runs via `node-cron`. Cron expressions are recomputed from config on every settings change:

| Job | Default interval | What it does |
|-----|-----------------|--------------|
| GitHub tick | Every 60 min | Fetch org repos, detect deletions, check each active repo |
| Website tick | Every 20 min | GET each enabled website URL, detect content changes |
| Twitter tick | Every 10 min | GET each Twitter URL, detect new posts, suspended-account via `defuddle` |
| Alert tick | Every 1 min | Fire Telegram/Pushbullet for unconfirmed events past their interval; auto-confirm after stop threshold |
| Price tick | Every 60 s | Batch-fetch DexScreener prices, upsert `token_prices` |
| Price alert tick | Every 1 min | Evaluate price pump/dump vs user thresholds, fire alerts |
| Log purge | Daily at midnight | Delete `check_logs` older than `log_retention_days`; prune `twitter_posts` to `twitter_posts_per_project` |

## Browser Activity Logging (see-me)

Dev tool for capturing browser console errors and auto-crawling the app:

```bash
# See all browser activity
see-me logs

# Find recent errors
grep "ERROR" .devlogger/browser.log | tail -5

# Search specific issues
grep -i "cannot read property" .devlogger/browser.log

# Live monitoring
tail -f .devlogger/browser.log
```

## License

MIT

# Project Checker

Monitor websites, GitHub repos, and Twitter accounts in one dashboard.

## Setup

```bash
pnpm install
cp .env.example .env    # optional — GITHUB_TOKEN for higher API rate limits
pnpm start
```

Open [http://localhost:3000](http://localhost:3000).

## What it monitors

| Resource | What it checks |
|----------|----------------|
| **Website** | HTTP status, response time, detects content changes via content hash |
| **GitHub org** | All public repos under a GitHub org URL — tracks latest commit SHA, commit count, stars, last push time |
| **Twitter** | Account accessibility and error states |

Each resource has a **sticky confirm** pattern: after confirming, the app tracks whether the status has changed since that confirmation. "Last changed" timestamps are recorded in the `resource_status_changes` table.

## Project structure

```
project-checker/
├── index.js              # Entry point, Express server setup
├── services/
│   ├── db.js             # sql.js init, schema, migrations
│   ├── checker.js        # Website, GitHub, Twitter check logic
│   ├── github.js         # GitHub API client
│   ├── migrations.js     # Idempotent schema migrations
│   └── scheduler.js      # node-cron job scheduling
├── routes/
│   ├── projects.js       # CRUD for projects + confirm endpoints
│   ├── dashboard.js      # Aggregated view for the UI
│   ├── settings.js       # App settings + manual triggers + danger zone
│   └── checkLogs.js      # Check log retrieval
└── public/index.html     # SPA dashboard (Vue 3)
```

## Database

SQLite via sql.js. The database file (`data/project-checker.db`) is created on first run. Migrations run automatically on every startup and are idempotent.

Key tables:
- `projects` — enabled flags and URLs for each resource
- `repos` — GitHub repos per project
- `check_logs` — every check result ever recorded
- `resource_status_changes` — only state transitions (changed/confirmed events)
- `config` — singleton app settings

## Settings

| Setting | Description |
|---------|-------------|
| `commit_check_minutes` | How often to check GitHub repos (default: 360) |
| `website_check_minutes` | How often to check websites (default: 1440) |
| `twitter_check_minutes` | How often to check Twitter (default: 1440) |
| `log_retention_days` | Auto-delete check logs older than N days (0 = disabled) |
| `ui_refresh_seconds` | Auto-refresh dashboard interval (0 = disabled) |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `GITHUB_TOKEN` | — | GitHub API token. Without it: 60 req/hr limit. With it: 5,000 req/hr. |

## API

- `GET /api/dashboard` — all projects with latest check statuses
- `GET /api/projects` — all projects
- `POST /api/projects` — create project
- `PUT /api/projects/:id` — update project
- `DELETE /api/projects/:id` — delete project
- `POST /api/projects/:id/confirm-website` — confirm website content hash
- `POST /api/projects/:id/confirm-twitter` — confirm Twitter status
- `GET /api/settings` — app settings
- `PUT /api/settings` — update check intervals
- `POST /api/settings/trigger-all` — run all checks now
- `POST /api/settings/trigger-websites` — run website checks now
- `POST /api/settings/trigger-github` — run GitHub checks now
- `POST /api/settings/trigger-twitter` — run Twitter checks now
- `POST /api/settings/clear-logs` — delete all check logs and status changes
- `POST /api/settings/clear-data` — delete all data, keep settings
- `GET /api/check-logs` — paginated check logs

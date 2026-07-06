# Project Checker

Monitor websites, GitHub repos, and Twitter accounts in one dashboard.

## Setup

```bash
pnpm install
pnpm start
```

Open [http://localhost:3000](http://localhost:3000).

## What it monitors

| Resource | What it checks |
|----------|----------------|
| **Website** | HTTP status, response time, detects content changes via MD5 hash |
| **GitHub org** | Per-repo: latest commit SHA, commit count, stars, last push time, latest tag |
| **Twitter** | Account accessibility and error states |

Each resource has a **sticky confirm** pattern: after confirming, the app tracks whether the status has changed since that confirmation. "Last changed" timestamps are recorded in the `event_logs` table.

## Project structure

```
project-checker/
├── index.js              # Entry point, Express server setup
├── services/
│   ├── db.js            # sqlite3 init, schema, migrations
│   ├── checker.js       # Website, GitHub, Twitter check logic
│   ├── github.js        # GitHub API client
│   ├── migrations.js    # Idempotent schema migrations
│   └── scheduler.js     # node-cron job scheduling
├── routes/
│   ├── projects.js      # CRUD for projects + repo management + confirm/check endpoints
│   ├── dashboard.js     # Aggregated view for the UI
│   ├── settings.js      # App settings + manual triggers + danger zone
│   └── checkLogs.js     # Check log and status change retrieval
└── public/
    ├── index.html       # Vue 3 SPA
    └── styles.css       # Pico CSS dark overrides
```

## Database

SQLite via sqlite3. The database file (`data/project-checker.db`) is created on first run. Migrations run automatically on every startup and are idempotent.

Key tables:
- `projects` — URLs, enabled flags, and per-resource settings
- `repos` — GitHub repos per project, with commit history and status tracking
- `check_logs` — every check result ever recorded
- `event_logs` — only state transitions (changed/confirmed/deleted events)
- `config` — singleton app settings

## Settings

| Setting | Description |
|---------|-------------|
| `github_check_minutes` | How often to check GitHub repos (default: 360) |
| `github_token` | GitHub personal access token — higher rate limits (5,000/hr vs 60/hr) and private repo access |
| `website_check_minutes` | How often to check websites (default: 1440) |
| `twitter_check_minutes` | How often to check Twitter (default: 1440) |
| `log_retention_days` | Auto-delete check logs older than N days (0 = disabled) |
| `ui_refresh_seconds` | Auto-refresh dashboard interval (0 = disabled) |
| `compact_activity` | Hide the Repositories section in the Activity view |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

## API

### Projects
- `GET /api/projects` — all projects
- `POST /api/projects` — create project (no auto-repo-fetch; use ManageRepos to add repos)
- `GET /api/projects/:id` — single project with repos and latest check logs
- `PUT /api/projects/:id` — update project (accepts `repos` array to sync)
- `DELETE /api/projects/:id` — delete project

### Repo management
- `GET /api/projects/:id/org-repos` — fetch all repos from the GitHub org (for ManageRepos UI)
- `POST /api/projects/:id/refresh-repos` — re-fetch all repos from GitHub, detect deleted repos
- `POST /api/projects/:id/add-repos` — upsert selected repos
- `DELETE /api/projects/:id/repos/:full_name` — remove a repo (full_name may contain `/`)

### Checks
- `POST /api/projects/:id/check-website` — run website check
- `POST /api/projects/:id/check-github` — run check for all active repos
- `POST /api/projects/:id/check-twitter` — run Twitter check

### Dashboard
- `GET /api/dashboard` — all projects with latest check statuses, repos, and deleted repos

### Settings
- `GET /api/settings` — app settings (singleton config row)
- `PUT /api/settings` — update settings (accepts any subset of config fields)
- `POST /api/settings/trigger-all` — run all checks for all projects now
- `POST /api/settings/trigger-websites` — run website checks for all projects now
- `POST /api/settings/trigger-github` — run GitHub checks for all projects now
- `POST /api/settings/trigger-twitter` — run Twitter checks for all projects now
- `POST /api/settings/clear-logs` — delete all check logs and status changes
- `POST /api/settings/clear-data` — delete all projects, repos, and logs; keep settings

### Logs
- `GET /api/check-logs` — paginated check logs (query params: `project_id`, `resource_type`, `limit`, `offset`)
- `GET /api/check-logs/status-changes` — paginated status change events (query params: `project_id`, `resource_type`, `limit`, `offset`)

# Route-to-Handler Map

## Mount Prefix → Router File

| Prefix | File |
|---|---|
| `/api/v1` | `routes/api.js` (public, bearer token) |
| `/api/projects` | `routes/projects.js` |
| `/api/check-logs` | `routes/checkLogs.js` |
| `/api/settings` | `routes/settings.js` |
| `/api/dashboard` | `routes/dashboard.js` |
| `/telWHook2345721453` | `routes/telegram-webhook.js` (no auth) |

## Routes

### Public API (bearer token)

```
POST /api/v1/projects/import     → import projects (single or array)
DELETE /api/v1/projects/remove    → delete project by token fields
```

### Projects (`/api/projects`)

```
GET    /                         list all user projects
POST   /                         create project
GET    /:id                      single project + repos + latest check_logs
PUT    /:id                      update project (+ optional repo sync)
DELETE /:id                      delete project (cascades)
GET    /:id/org-repos           fetch all repos from GitHub org (for RepoManager)
POST   /:id/refresh-repos        re-fetch all repos, detect deletions
POST   /:id/add-repos            upsert selected repos from GitHub
DELETE /:id/repos/*              hard-delete a specific repo (supports "owner/repo" names)
POST   /:id/check-website        run website check immediately
POST   /:id/check-github         run github check for all active repos
POST   /:id/check-twitter        run twitter check immediately
GET    /:id/twitter-posts        list stored posts for project
```

### Dashboard (`/api/dashboard`)

```
GET    /                         aggregated view: project status + latest checks
GET    /token-prices             all token prices for user's enabled projects
```

### Check Logs (`/api/check-logs`)

```
GET    /                         check_logs entries (filterable, sortable, paginated)
GET    /status-changes           event_logs entries (filterable, sortable, paginated)
PATCH  /status-changes/:id/confirm  confirm/unconfirm a status change
POST   /status-changes/confirm-all  confirm all unconfirmed status changes
GET    /alerts                   alert_logs entries (filterable, sortable, paginated)
```

### Settings (`/api/settings`)

```
GET    /                         get all settings (check intervals, alerts, notifications, tokens)
PUT    /                         update settings
GET    /proxy-stats             per-proxy success/failure stats
DELETE /proxy-stats              clear all proxy stats
POST   /trigger-all              run all checks for all user projects
POST   /trigger-websites        run website check for all projects
POST   /trigger-github          run github check for all projects
POST   /trigger-twitter         run twitter check for all projects
POST   /clear-data              delete all user projects + cascade
POST   /clear-logs              delete all check_logs + event_logs
POST   /clear-alert-logs        delete all alert_logs
POST   /generate-api-token       generate a new PC_ token
```

### Telegram Webhook (no session)

```
POST /telWHook2345721453         receive callback_query confirmations from bot
```

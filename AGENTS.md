# Agent Configuration

## Project Overview
Express + sql.js backend monitoring websites, GitHub orgs, and Twitter accounts. Vue 3 SPA frontend.

## Styling
Before creating or styling HTML elements, check [Pico CSS docs via Context7](https://picocss.com/docs) to use Pico's native classes and patterns first.

## Project Structure
```
services/
  db.js          # sql.js init, schema, lazy proxy
  checker.js     # checkWebsite, checkGithubRepo, checkTwitter, logCheck
  github.js      # fetchReposForOwner, fetchCommitHistory
  scheduler.js   # node-cron jobs
  migrations.js  # idempotent schema migrations
routes/
  projects.js    # CRUD + confirm endpoints
  dashboard.js   # aggregated view
  settings.js    # app settings + danger zone
  checkLogs.js   # GET /check-logs, GET /check-logs/status-changes
public/
  index.html     # Vue 3 SPA
  styles.css     # Pico dark overrides
```

## Common Tasks
- `pnpm install` — install deps
- `pnpm start` — run server
- `pnpm dev` — run with live reload


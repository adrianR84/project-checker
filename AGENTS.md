# Agent Configuration

**All agents must obey the rules in this file. Do not commit without the user's consent.**

## Styling
Before creating or styling HTML elements, check [Pico CSS docs via Context7](https://picocss.com/docs) to use Pico's native classes and patterns first.

## Common Tasks
- `pnpm install` — install deps
- `pnpm start` — run server
- `pnpm dev` — run with live reload
- `pnpm dev:log` — run dev server with output also saved to `logs/output.log` (last execution only)

## Logs
Dev server output is captured in `logs/output.log`. When user asks to check/read logs, read that file.

## Planning
When creating a plan, delegate both research AND writing to subagents (e.g., a `Plan` agent or parallel agents). Research relevant subsystems first, then write the plan itself — do not draft plans inline in the main conversation.

If a plan is saved globally (e.g., to the global memory or vault), also save a copy locally under `.claude/PLANS/<slug>.md` so the project retains its own copy.

## Database
`CREATE TABLE IF NOT EXISTS` only creates tables on a fresh DB — it never updates existing schemas. All structural changes (columns, constraints, CHECK values) must be added as **both**:
1. A migration in `services/migrations.js` (idempotent, runs on every init)
2. The initial `CREATE TABLE` statement in `services/db.js` (only for new DBs)


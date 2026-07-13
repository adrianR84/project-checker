# Improvements Roadmap

## Data & Exports

- **CSV/JSON export** for check logs, event logs, price history
- **Bulk enable/disable projects**

## Alerting

- **Discord webhook support**
- **Email alerts** (e.g. via Resend/SendGrid)
- **Alert escalation** — escalating messages if not acknowledged

## Monitoring

- **WebSocket / SSE instead of polling** for live updates
  - SSE endpoint pushes data to browser on-change (no polling interval)
  - Prices table refreshes instantly, event logs appear immediately
  - Keep REST API for initial page loads and manual actions
- **Retry logic** on failed checks (2–3 attempts before marking failed)
- **Per-project check intervals** (e.g. "check this site every 6h, that one every day")

## UI

- **Price chart history** (sparkline or full chart per token)
- **Dashboard overview** with key stats (total projects, uptime %, recent alerts)
- **Dark/light theme toggle**

## Auth / Multi-user

- **Invite links / user management** for the admin
- **Per-user project ownership**

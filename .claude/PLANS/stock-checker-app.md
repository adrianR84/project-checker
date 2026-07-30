# Stock Checker — Implementation Plan

## Context

Personal stock price monitor. Same architecture as project-checker: Express + SQLite backend, Vue 3 SPA, scheduler for periodic updates, Telegram/Pushbullet alerts. Data source: **Alpaca** (free IEX real-time tier, unlimited REST, 30 WebSocket subscriptions).

Single-user (no better-auth needed — `SKIP_AUTH=1` always). Should be installable in under 5 minutes with just an Alpaca API key.

---

## Scope

**In scope:**
- Watchlist management (multiple lists, add/remove/reorder tickers)
- Real-time price fetching via Alpaca WebSocket (IEX market data)
- Price chart history (1D / 5D / 1M / 3M / 1Y) from Alpaca REST
- Price alerts (above/below threshold, % change) with Telegram/Pushbullet
- Alert log
- Settings UI (refresh rate, notification channels)

**Out of scope:**
- Auth system (single-user, `SKIP_AUTH=1` always)
- Multiple users
- Portfolio tracking / P&L
- Market hours / pre-market / after-hours awareness
- Paper trading

---

## File Structure

```
stock-checker/
├── index.js                    # Express entry point
├── package.json
├── .env.example
├── services/
│   ├── db.js                   # SQLite schema + init
│   ├── alpaca.js               # Alpaca WS + REST client wrapper
│   ├── scheduler.js            # node-cron: price fetch + alert eval
│   └── notifications.js        # Telegram + Pushbullet
├── routes/
│   ├── stocks.js               # CRUD: watchlists, tickers, snapshots
│   └── settings.js             # Config read/write, alert CRUD
├── public/
│   ├── index.html              # Vue 3 SPA (CDN)
│   └── styles.css              # Pico CSS + dark overrides
└── utils/
    ├── logger.js
    └── kill-ports.js
```

---

## Database Schema

### `watchlists`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| user_id | TEXT | hardcoded `'local-dev'` |
| name | TEXT | e.g. "Tech Stocks" |
| sort_order | INTEGER | |

### `tickers`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| watchlist_id | INTEGER FK | → watchlists.id |
| symbol | TEXT | e.g. "AAPL" |
| name | TEXT | company name |
| exchange | TEXT | e.g. "NASDAQ" |
| sort_order | INTEGER | |

### `price_snapshots`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| ticker_id | INTEGER FK | → tickers.id |
| price | REAL | |
| open, high, low, close | REAL | |
| volume | INTEGER | |
| trade_count | INTEGER | |
| vwap | REAL | |
| snapshot_at | TEXT | |

### `alerts`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| ticker_id | INTEGER FK | → tickers.id |
| user_id | TEXT | |
| condition | TEXT | `'above'` / `'below'` / `'change_above'` / `'change_below'` |
| threshold | REAL | price or % |
| last_triggered | TEXT | throttle |

### `alert_logs`
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| alert_id | INTEGER FK | |
| ticker_id | INTEGER | denormalized |
| symbol | TEXT | denormalized |
| price_at_trigger | REAL | |
| condition | TEXT | |
| threshold | REAL | |
| triggered_at | TEXT | |

### `config`
Singleton row for refresh rate and notification tokens.

---

## API Surface

### Watchlists
- `GET /api/stocks/watchlists` — all watchlists with tickers + latest price per ticker
- `POST /api/stocks/watchlists` — create watchlist `{ name }`
- `PUT /api/stocks/watchlists/:id` — rename `{ name }`
- `DELETE /api/stocks/watchlists/:id` — delete + cascade tickers

### Tickers
- `POST /api/stocks/watchlists/:id/tickers` — add ticker `{ symbol, name?, exchange? }`
- `DELETE /api/stocks/watchlists/:id/tickers/:tickerId` — remove ticker

### Prices
- `GET /api/stocks/tickers/:id/history?range=1D|5D|1M|3M|1Y` — OHLCV snapshots from DB

### Alerts
- `GET /api/stocks/alerts` — all alerts with ticker info
- `POST /api/stocks/alerts` — create `{ ticker_id, condition, threshold }`
- `DELETE /api/stocks/alerts/:id`

### Settings
- `GET /api/settings` — config (refresh_seconds, notification tokens)
- `PUT /api/settings` — update config
- `GET /api/settings/alert-logs` — alert history
- `DELETE /api/settings/alert-logs` — clear logs

---

## Scheduler

| Job | Interval | What |
|-----|----------|------|
| Alpaca reconnect | On schedule start | Connect to `wss://stream.data.alpaca.markets/v2/iex` |
| Price snapshot | `refresh_seconds` (default 10s) | Insert price_snapshots for all tracked tickers |
| Alert evaluation | `alert_refresh_seconds` (default 30s) | Check alerts vs latest snapshot, fire + throttle |

Alpaca WebSocket handles real-time streaming. On each trade tick, upsert latest price in memory + persist snapshot on scheduler tick.

---

## Key Decisions

1. **Alpaca over Yahoo** — real-time (not scraped), stable, free tier is unlimited for personal use
2. **No auth** — single-user; `SKIP_AUTH=1` always
3. **No DB migrations** — `CREATE TABLE IF NOT EXISTS` only; fresh schema per install
4. **No chart API calls** — chart data served from `price_snapshots` table already in DB
5. **No portfolio/PnL** — out of scope, adds significant complexity
6. **Notifications** — reuse same Telegram/Pushbullet pattern from project-checker

---

## Steps

1. Create directories + `package.json` + `.env.example`
2. `services/db.js` — schema
3. `services/alpaca.js` — WebSocket + REST client
4. `services/notifications.js` — Telegram + Pushbullet
5. `services/scheduler.js` — cron jobs
6. `routes/stocks.js` — watchlist/ticker CRUD + prices
7. `routes/settings.js` — config + alerts
8. `public/index.html` — Vue 3 SPA with Pico CSS
9. `public/styles.css`
10. `utils/logger.js`, `utils/kill-ports.js`
11. `index.js` — entry point
12. `pnpm install` + test run

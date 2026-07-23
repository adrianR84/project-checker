# SSL Certificate Expiry Monitoring

## Goal
Monitor TLS certificate expiration for project websites and fire alerts as certs approach expiry, reusing the existing event/alert infrastructure.

## What gets recorded

### check_logs.details (JSON)
Two new fields appended to existing website check details:
```json
{
  "content_hash": "abc123",
  "cert_expiry_days": 47,
  "cert_will_expire_at": "2025-09-15T00:00:00Z"
}
```
- `cert_expiry_days`: integer, days until cert expires (negative = expired)
- `cert_will_expire_at`: ISO date string of `cert.valid_to`

### event_logs.event_type (new variants)
Reuse existing event_logs table. New event types:
- `cert_expiring_30` — cert ≤ 30 days
- `cert_expiring_14` — cert ≤ 14 days
- `cert_expiring_7`  — cert ≤ 7 days
- `cert_expired`     — cert has expired

Each fires **once per threshold crossing** (transitioning from ok → 30d, 30d → 14d, etc.), not every check. Uses existing `confirmed` flag.

### Config
Two new fields in website alert settings (in `config.settings` JSON):
- `cert_alert_threshold_days` — comma-separated list of thresholds to alert on (default: `30,14,7`)
- `cert_alert_interval_minutes` — alert repeat interval for cert events; `0` = reuse `website_alert_interval_minutes`

## Files to change

### `services/db.js`
- `CREATE TABLE IF NOT EXISTS event_logs` — add 4 new variants to `event_type` CHECK constraint: `'cert_expiring_30'`, `'cert_expiring_14'`, `'cert_expiring_7'`, `'cert_expired'`

### `services/migrations.js`
- Add `add_cert_event_types` migration: rebuilds event_logs to expand CHECK constraint (idempotent, same pattern as `fix_rsc_event_type_check` and `add_price_to_event_logs_resource_type`)
- Call it in `runMigrations`

### `services/checker.js`
- `checkWebsite()`: after `fetchWithTimeout` succeeds, get the socket from `res.socket`, call `tls.connect()` or read from existing socket's `getPeerCertificate()` to get `valid_to`. Compute `cert_expiry_days = Math.ceil((valid_to_ms - Date.now()) / 86400000)`. Append to `result.details`.
- Threshold crossing detection: before updating `result.details`, query the most recent event_log for this project's website where `event_type LIKE 'cert_%'`, compare to current threshold, fire `recordStatusChange` if crossed.
- No new dependencies — use Node.js built-in `tls` module.

### `public/index.html`
- `statusClass()`: map `cert_expiring_30` → `'pending'`, `cert_expiring_14` → `'changed'`, `cert_expiring_7` → `'error'`, `cert_expired` → `'error'`
- `logDetail()`: render cert expiry in details column when `event_type` starts with `cert_` (e.g. `"Cert expiring in 14 days"`)
- `ProjectCard` website row: add a cert-expiry badge after the status badge — e.g. `🌐  22d` — color-coded: green >30d, yellow ≤30d, orange ≤14d, red ≤7d, bold red if expired. Only shown when `cert_expiry_days` is present in the latest website check details.
- ProjectForm: add a small tooltip label "Check SSL cert expiry" next to the Website URL field (informational — always enabled for HTTPS URLs).

## UI Summary

Website row in ProjectCard (new column "Expiry"):
```
| Res  | Mon | Status | Checked | Expiry |
| 🌐   | ✓   | ok     | 3h ago |   47d  | ← green
| 🌐   | ✓   | ok     | 3h ago |   22d  | ← yellow
| 🌐   | ✓   | ok     | 3h ago |    5d  | ← red
```

Event Logs:
```
| Project | Type | Event              | When   | Details           |
| Proj A  | 🌐   | cert_expiring_30   | 2h ago | Cert expires in 22 days |
| Proj B  | 🌐   | cert_expiring_7    | 6m ago | Cert expires in 5 days  |
```

## What could break
- `tls.connect()` on proxied/HTTPS sites behind a CDN (Cloudflare strips cert info). Document limitation: for sites behind full-proxy CDNs the socket cert may be the CDN cert, not the origin cert.
- Node.js version compatibility for `socket.getPeerCertificate()` — works on Node 22 but some embedded fetch layers may not expose it.

## Tests to add
- `checker.test.js`: mock `fetch` returning a socket with `getPeerCertificate() → { valid_to: '2025-09-01T00:00:00Z' }`, assert `cert_expiry_days` is computed correctly.
- Threshold crossing: mock DB with last event of `cert_expiring_30`, assert `cert_expiring_14` fires when crossing 14-day boundary, but not again on subsequent checks.

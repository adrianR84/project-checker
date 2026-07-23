# Move projects.token / token_enabled → one-to-many `tokens` table

## Context

Today each project stores its token as a single scalar pair in `projects`:
`projects.token` (JSON `{symbol, contract, chain}`) and `projects.token_enabled`
(scalar 0/1). Downstream, `token_prices.project_id` is `PRIMARY KEY` and
`token_prices_alerts` PK is `(project_id, price_change)`. Every consumer
(scheduler, dashboard, prices table, alerts, project form, import/export,
public bearer API) assumes a project has zero or one token. The user wants
one project to track multiple tokens with per-token enable/disable, and the
add/edit form to add/remove token rows. Every consumer needs to follow the
new shape. The plan moves tokens out of `projects` into a dedicated
`tokens` table and rekeys `token_prices` and `token_prices_alerts` to
`token_id` (FK cascade from `projects`).

## Decisions needed (none blocking — defaults below are safe; confirm if you want to deviate)

1. **Public API v1 import shape** — keep accepting the legacy single
   `{ symbol, contractAddress, chainId }` body (coerced to a 1-element
   `tokens` array) so existing clients and JSON exports keep working. New
   clients can pass `tokens: [{ symbol, contract, chain, enabled }]`.
2. **Public API v1 remove** — keep matching by single token triple; it now
   finds the project that owns a matching `tokens` row.
3. **Tokens are optional on a project** — a project can have zero tokens.
4. **Per-token `enabled` flag** — replaces project-level `token_enabled` for
   price-alert gating; price *fetching* is gated on contract presence, and
   `p.enabled=1 AND tk.enabled=1` for alert evaluation.
5. **Uniqueness** — `UNIQUE (project_id, contract, chain)` so duplicate
   contract+chain per project is rejected (NULL contract allowed because
   SQLite UNIQUE treats NULLs as distinct).
6. **JSON-tab edit + import/export** — round-trip the new `tokens` array
   while still accepting the legacy single-token shape (coerced) for
   backward compatibility.

## Data model — final shape

```sql
tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  symbol     TEXT,
  contract   TEXT,
  chain      TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, contract, chain)
);
CREATE INDEX idx_tokens_project_id ON tokens (project_id);

token_prices (
  token_id INTEGER PRIMARY KEY,           -- was project_id
  symbol, chain, contract, price_usd, price_change_h1/h6/h24,
  liquidity_usd, volume_h24, market_cap, pair_created_at, fetched_at,
  FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
);

token_prices_alerts (
  token_id INTEGER NOT NULL,              -- was project_id
  price_change REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (token_id, price_change),
  FOREIGN KEY (token_id) REFERENCES tokens(id) ON DELETE CASCADE
);
```

`projects.token` and `projects.token_enabled` are removed. API project
shape gains `tokens: [{ id, symbol, contract, chain, enabled }]`.

## Files modified (≤3 per task)

| # | Files | Goal |
|---|---|---|
| 1 | `services/db.js`, `utils/drop-tables.js` | New `tokens` table in init CREATE; rekey `token_prices` & `token_prices_alerts` to `token_id`; drop `projects.token` / `token_enabled` from init CREATE. `drop-tables.js` lists `tokens` between `token_prices*` and `repos`. |
| 2 | `services/migrations.js` | 5 idempotent migrations, wired into `runMigrations` in order: create `tokens` → backfill one row per project from `projects.token` JSON + `token_enabled` (idempotent via `NOT IN`) → rekey `token_prices` to `token_id` via rebuild JOINing on `tokens.project_id` → rekey `token_prices_alerts` similarly → rebuild `projects` to drop `token` and `token_enabled` columns. Each wrapped in try/catch like the existing `compact_projects_url_cols` recipe. |
| 3 | `routes/projects.js` | Replace scalar `token`/`price_enabled` with `tokens: []`. New helper `attachTokens(project)` queries `tokens WHERE project_id = ?`. `GET /` batch-loads all tokens; `GET /:id` and `POST`/`PUT` responses include `tokens`. PUT syncs tokens like repos: upsert by `id` (or by contract+chain for new rows), delete tokens not in the submitted list, DexScreener-enrich per row. Add `PATCH /:id/tokens/:tokenId { enabled }` for the Prices-tab toggle. The pre-existing `tokenJson`-before-declaration bug at L145/152 folds naturally into the rewrite. |
| 4 | `routes/dashboard.js`, `routes/api.js` | `dashboard.js` attaches `tokens` to each project; `/token-prices` joins `token_prices tp JOIN tokens tk ON tk.id = tp.token_id JOIN projects p ON p.id = tk.project_id` and selects one row per token (`token_id`, `tk.enabled AS price_enabled`, etc.). `api.js` import accepts `tokens: []` (or coerces legacy `symbol/contractAddress/chainId` to a 1-row array), inserts a project, then inserts each token row; remove by matching a project that owns the supplied triple. |
| 5 | `services/scheduler.js`, `services/notifications.js` | Scheduler iterates `tokens` (`runTokenPriceTick` / `upsertTokenPrice` use `token_id`; `evaluatePriceAlerts` keyed by token with `symbol` threaded through; `runPriceAlertTick` selects `tokens JOIN projects WHERE p.enabled=1 AND tk.enabled=1`). `notifications.formatPriceAlert` / `formatPriceAlertHtml` gain a `symbol` arg and prefix the message with `$SYMBOL` so multi-token projects are distinguishable in Telegram/Pushbullet. |
| 6 | `public/index.html` (ProjectForm) | Replace the single token `form-row` (L769–780) with a repeating block modelled on the existing `price-alerts` rows (L2551–2573). State: `f.tokens = [{ symbol, contract, chain, enabled }, ...]`. Add/remove row buttons. Per-row contract `@blur` calls `lookupTokenForRow(i)`. `watch(initial)` populates from `v.tokens || []` (falls back to legacy `v.token` object as 1-row). `onSubmit` emits `{ ..., tokens: f.tokens.filter(non-empty) }`. JSON tab maps `tokens` array (still accepts legacy `symbol/contractAddress/chainId` → 1 row). |
| 7 | `public/index.html` (rest of SPA) | Prices tab keyed by `row.token_id`; toggle calls new `api.setTokenEnabled(row.project_id, row.token_id, val)` → `PATCH /projects/:id/tokens/:tokenId`. Tint maps keyed by `token_id`. Project table Token cell lists `p.tokens` (symbol links). ProjectCard token summary uses `tokens` (per-token line). Import builds `tokens` array (`item.tokens` or legacy single). Export writes `tokens: p.tokens`. Update the `api` wrapper (L78) with `setTokenEnabled(projectId, tokenId, enabled)`. Update `tok(p)` helper (L2434) to return `p.tokens || []`. |
| 8 | `test/migrate-tokens.test.js`, `package.json` | One `node --test` file (no deps). Builds the pre-migration schema in a temp SQLite DB, seeds a project with scalar `token` + `token_prices` + alert row, runs `runMigrations`, asserts: `tokens` row exists with correct fields, `token_prices.token_id` points to the new token, `token_prices_alerts` rekeyed, `projects` has no `token`/`token_enabled`. Re-runs `runMigrations` and asserts idempotency (no duplicate tokens, no errors). `package.json` `"test": "node --test"`. |

## Key existing code being reused (don't reimplement)

- `services/migrations.js` rebuild pattern: see `compact_projects_url_cols`
  (L517–660) and `add_price_to_event_logs_resource_type` (L437–470) — exact
  template for `_old` rename / CREATE / INSERT…SELECT / DROP.
- `hasColumn(db, table, col)` helper (L5) for idempotency guards.
- `routes/projects.js` repo sync loop (L278–291) — model for the new
  token sync in PUT.
- `services/db.js` `bindParams` (L200) — auto-converts JS objects to JSON;
  arrays of token rows go through unchanged.
- `public/index.html` `price-alerts-table` markup + CSS
  (`public/styles.css` L493–540) — the only repeating-row pattern in the
  SPA. The new token rows reuse the same `.form-row-group`/grid style.
- `public/index.html` `api` wrapper (L78–115) — add `setTokenEnabled` here.
- `services/scheduler.js` DexScreener call (L244–266) — refactor to loop
  over `tokens` rows.
- `services/notifications.js` `formatPriceAlert*` (L189–205) — gain a
  `symbol` param; one symbol prefix is the only behavioral change.

## API/UI/import-export compatibility

- **API GET/PUT project**: `tokens: [...]` replaces `token` + `price_enabled`.
- **Public API v1 import**: accepts `tokens: [...]` OR legacy
  `symbol/contractAddress/chainId` (coerced to a 1-element `tokens` array).
- **JSON import/export**: `tokens: [...]` is the primary shape; export
  always writes it; import accepts either shape. Round-trip preserves
  every token with its `enabled` flag.
- **ProjectForm on edit**: reads `v.tokens` (new) and falls back to
  `v.token` (legacy) for one rollout window.

## Migration order (in one `runMigrations` pass)

1. `add_tokens_table` — create `tokens` if missing + index.
2. `migrate_project_token_to_tokens` — guard: `hasColumn(projects,'token')`.
   Insert one row per project with a non-empty scalar token, skipping
   projects already represented in `tokens`. Idempotent.
3. `rekey_token_prices_to_token_id` — guard: `hasColumn(token_prices,'project_id')`.
   Rebuild the table keyed on `token_id` (FK to `tokens.id`) joining the old
   `project_id` to the migrated token rows. Rows whose project had no
   migrated token are dropped (acceptable — re-fetched next tick).
4. `rekey_token_prices_alerts_to_token_id` — same pattern.
5. `drop_projects_token_cols` — guard: `hasColumn(projects,'token')`. Full
   `projects` rebuild removing `token` and `token_enabled`; recreates
   `idx_projects_user_id`. **Must run last** so the data still readable
   in steps 2–4.

## Verification

1. **Automated**: `pnpm test` runs the migration test in Task 8 — covers
   the data-preservation money path and idempotency.
2. **Manual fresh DB**: drop `data/project-checker.db`, `pnpm start`,
   confirm `tokens` table created and `projects` has no `token` /
   `token_enabled` columns. Create a project with 2 tokens. GET shows
   `tokens: [...]`.
3. **Manual migration on live DB copy**: copy `data/project-checker.db`,
   `pnpm start` — migration log shows the new migrations running once.
   Inspect `tokens` rows are populated 1:1 with old scalar tokens.
   `token_prices.token_id` matches. Re-run `pnpm start` — no log noise,
   no duplicates.
4. **UI smoke**: Add a project with 2 tokens in the modal; reload the
   modal in edit — both rows restored. Toggle one off in Prices tab —
   scheduler stops fetching that one (verify with `SCHEDULER_DEBUG=1`).
5. **Export→import round-trip**: Export → `pnpm drop-tables` →
   `pnpm start` → Import — projects + tokens restored.
6. **Alert attribution**: trigger a price threshold for a 2-token
   project — one Telegram/Pushbullet message names the symbol.

## Risks / edge cases

- **Orphan `token_prices` row** whose project had no valid migrated token
  is dropped (acceptable; re-fetched next tick). Documented as a comment
  in the migration.
- **Duplicate contract+chain** on PUT sync returns 409 (caught by the
  `UNIQUE` constraint). Frontend should dedupe before submit.
- **Contract-less tokens** (symbol only) are allowed; scheduler skips
  them (`contract IS NOT NULL`).
- **DexScreener enrichment** now loops per token — only enrich rows
  missing `symbol` or `chain` (current guard preserved).
- **Multi-user**: every token query must scope through `projects.user_id`
  (join, never trust a `token_id` from the client without project
  ownership check).
- **Prices tab row key** changes from `project_id` to `token_id`; the
  SPA's `priceRowTint` / `priceCellTint` and the `tint[*] = ...` index
  updates are in Task 7.

## Out of scope (ponytail)

- No `tokens` timestamps — add only if audit need appears.
- No new npm dependencies; tests via built-in `node:test`.
- No bulk token-management UI beyond add/remove rows.
- No CSV / per-token trigger endpoint — per-token `enabled` toggle is
  covered by the new PATCH route.

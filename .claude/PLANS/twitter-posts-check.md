# Twitter posts check (pc) — feature plan

## Context

The `projects.twitter` JSON column already has a `pc` field, but it's dead: hardcoded to `1` on create, never read for behavior, and `parseProjectRow` even misuses it as the master `twitter_enabled` flag. We're wiring it up properly: a per-project "posts check" toggle, a `twitter_posts` table that records every fetched post (deduped by tweet id), and a new path inside `checkTwitter()` that fetches the latest posts via nitter RSS and reports new posts as `status='changed'` / `event_type='changed'` events — mirroring the existing website content-check pattern.

The `pc` JSON field stays (matches the website `cc` pattern). API field is `twitter_posts_check` (matches `website_content_check` naming). Existing rows are **not** backfilled — they keep whatever `pc` they have, users opt-in via the UI.

## Critical files to modify

| File | Change |
|------|--------|
| `services/db.js` | Add `twitter_posts` CREATE TABLE in `init()` after the `repos` table block (around line 73) |
| `services/migrations.js` | Add `add_twitter_posts_table(db)` idempotent function + register in `runMigrations` |
| `package.json` | Add `"rss-to-json": "^2.0.0"` to `dependencies`, run `pnpm install` |
| `services/checker.js` | Add `fetchAndStoreTwitterPosts(projectId, handle, project)`, plumb `pc` into `checkTwitter()`, call from inside the 200-response branch, write `status='changed'` + `event_logs` row when new posts found |
| `services/scheduler.js` | Plumb `pc` into `checkTwitter()` call in `runTwitterTick` (line 79) |
| `routes/projects.js` | Accept `twitter_posts_check` in POST/PUT; write `pc` correctly in JSON; **fix `parseProjectRow` bug** (read `pc` from JSON, stop overwriting `twitter_enabled`); add `twitter_posts_check` to PUT `allowed` whitelist; new `GET /:id/twitter-posts` endpoint |
| `public/index.html` | Add "Posts Check" checkbox to the Twitter form-row, init in form state, sync in edit-mode, include in `emit('submit', ...)`, include in import mapping |

## Detailed design

### 1. New `twitter_posts` table

**In `services/db.js` `init()`** — add right after the `repos` CREATE TABLE block (db.js:50-73):

```sql
CREATE TABLE IF NOT EXISTS twitter_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  post_id TEXT NOT NULL,
  author TEXT,
  link TEXT,
  content TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, post_id)
);
```

**In `services/migrations.js`** — add a function that does an `INSERT OR IGNORE` probe (mirrors the `add_token_prices_table` pattern at migrations.js:334-355) and registers in `runMigrations`:

```js
/** Migration: ensures twitter_posts table exists for legacy DBs. */
function add_twitter_posts_table(db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='twitter_posts'"
  ).get();
  if (row) return;
  try {
    db.exec(`
      CREATE TABLE twitter_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        post_id TEXT NOT NULL,
        author TEXT, link TEXT, content TEXT, published_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE (project_id, post_id)
      );
    `);
  } catch (err) {
    console.error(`[${now()}] add_twitter_posts_table failed: ${err.message}`);
  }
}
```

The `UNIQUE (project_id, post_id)` constraint gives us free dedup via `INSERT OR IGNORE`.

### 2. `checkTwitter()` — new posts path

In `services/checker.js`:

- Add a new exported helper `fetchAndStoreTwitterPosts(projectId, handle, opts)` that:
  1. Builds nitter URL: `https://nitter.net/${handle}/rss` (handle = strip `https://twitter.com/` / `https://x.com/` and any leading `/` from `twitter.url`).
  2. Fetches RSS XML with the existing `fetchWithTimeout(url, 15000, ...)` helper. (`rss-to-json` is callback-style; we'll fetch the raw XML ourselves and parse it — see step 3.)
  3. Parses with `rss-to-json`.
  4. For each item in `feed.items`, run `INSERT OR IGNORE INTO twitter_posts (...) VALUES (...)`. Items with `guid` or `id` map to `post_id`; fall back to `link` if no guid.
  5. Counts how many rows were actually inserted (use `result.changes` from the prepared statement, or count via a second SELECT — simpler: pre-fetch existing post_ids in a `Set`, count the diff).
  6. Returns `{ newPosts: number, newPostIds: string[] }`.

- Modify `checkTwitter(url, projectId, opts = {})`:
  - Add third param `opts = { postsCheck = false, handle = null }`.
  - When `res.ok` AND `opts.postsCheck` AND `opts.handle`:
    - Try `await fetchAndStoreTwitterPosts(projectId, opts.handle)`.
    - If `newPosts > 0`: set `newStatus = 'changed'`, attach `details = { new_posts: newPosts, post_ids: [...] }`.
    - Also call `recordStatusChange(projectId, 'twitter', 'changed', { new_posts: newPosts, post_ids: [...] })`.
  - Existing `changed` transition logic at `checker.js:316-320` (the `lastStatus !== newStatus` block) handles writing `status='changed'` to `check_logs` naturally — the new posts branch just sets the new status before that block runs, so the existing transition detection marks the change without duplication.
  - The HTTP-status-only change block at `checker.js:322-328` (records event on 200→500 etc.) should run **after** the new-posts branch and **not** be triggered by the new-posts path (it checks `lastHttpStatus !== res.status`, which is the same `res.status` either way — so it's safe, just leave it).

- Export `fetchAndStoreTwitterPosts` from `checker.js` so routes/scheduler can call it directly if needed (and so `require()` from checker.js is the single import point for both).

### 3. RSS parsing — use `rss-to-json` per the spec

`rss-to-json` has a callback API. In `services/checker.js`, wrap with `util.promisify`:

```js
const { promisify } = require('util');
const rssToJson = promisify(require('rss-to-json'));
// ...
const feed = await rssToJson(nitterUrl);
```

If the parse throws or returns no items, treat as "0 new posts" — don't fail the whole twitter check (the HTTP 200 already succeeded; this is best-effort). Log to console.

If `rss-to-json` is not installed yet, `require()` will throw at startup. Add to `package.json` `dependencies` (`"rss-to-json": "^2.0.0"` is the current major per the npm page) and run `pnpm install`.

### 4. `services/scheduler.js` — pass `pc` into the check

`runTwitterTick` at scheduler.js:70-85 currently does:

```js
const r = await checkTwitter(parsed.url, p.id);
```

Change to:

```js
const r = await checkTwitter(parsed.url, p.id, { postsCheck: !!parsed.pc, handle: handleFromUrl(parsed.url) });
```

Add a tiny `handleFromUrl(url)` helper at the top of `scheduler.js`:

```js
function handleFromUrl(url) {
  return String(url || '').replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//, '').replace(/^\/+/, '').replace(/\/.*$/, '').trim();
}
```

The frontend already does essentially this transformation at `index.html:1027, 1460` — keep the helpers consistent (or import from a shared util; for now, duplicate the one-liner in scheduler.js and in checker.js — it's 3 lines, not worth a util file).

### 5. `routes/projects.js` — accept `twitter_posts_check` + fix `parseProjectRow`

**`parseProjectRow` (lines 11-23) — fix the bug:**

Currently line 19 reads:
```js
twitter_enabled: row.twitter ? (JSON.parse(row.twitter).pc ?? 1) : 1,
```

This is wrong on two axes:
1. It uses JSON `pc` to populate the flat `twitter_enabled` field, which is a different concept.
2. The flat `twitter_enabled` column already exists on the row (returned by `SELECT *`) — this overwrites it with whatever was in `pc`.

Replace with:
```js
twitter_enabled:      row.twitter_enabled,                                          // keep flat column as-is
twitter_posts_check:  row.twitter ? (JSON.parse(row.twitter).pc ?? 1) : 1,          // new field
```

This is a behavior fix bundled with the feature — necessary for the new field to work, and for `twitter_enabled` (master on/off) to not be silently clobbered.

**POST `/:id` (line 127) — read the new field:**

Change:
```js
const twitterJson  = twitter_url  ? JSON.stringify({ url: twitter_url, pc: 1 }) : null;
```

To:
```js
const twitter_posts_check_val = req.body && Object.prototype.hasOwnProperty.call(req.body, 'twitter_posts_check')
  ? (twitter_posts_check ? 1 : 0)
  : 1; // default ON for new projects (matches website_content_check)
const twitterJson = twitter_url ? JSON.stringify({ url: twitter_url, pc: twitter_posts_check_val }) : null;
```

Also plumb `pc` into the post-create check at line 162: pull `parsed.pc` from the just-stored JSON and pass `{ postsCheck, handle }` to `checkTwitter`.

**PUT `/:id` (lines 182-184) — add to whitelist:**

```js
const allowed = ['name', 'website_url', 'github_url', 'twitter_url', 'telegram_url',
                 'website_enabled', 'website_content_check', 'github_enabled', 'twitter_enabled', 'telegram_enabled',
                 'twitter_posts_check', // <-- new
                 'token', 'enabled', 'price_enabled'];
```

**PUT write-adapter (lines 211-220) — handle the new field correctly:**

Replace the existing twitter block with:
```js
if ('twitter_url' in updates) {
  // Both url and pc may be in the same request — preserve incoming pc
  const incomingPc = ('twitter_posts_check' in updates)
    ? (updates.twitter_posts_check ? 1 : 0)
    : (existing.twitter ? (JSON.parse(existing.twitter).pc ?? 1) : 1);
  updates.twitter = updates.twitter_url
    ? JSON.stringify({ url: updates.twitter_url, pc: incomingPc })
    : null;
  delete updates.twitter_url;
  delete updates.twitter_posts_check;
} else if ('twitter_posts_check' in updates) {
  // Only pc changing — patch in place to preserve url
  const tw = existing?.twitter ? JSON.parse(existing.twitter) : {};
  tw.pc = updates.twitter_posts_check ? 1 : 0;
  updates.twitter = JSON.stringify(tw);
  delete updates.twitter_posts_check;
}
```

The existing `twitter_enabled` strip at lines 215/217-220 still works (it's about the master flag, not `pc`). Leave it.

**New endpoint: `GET /:id/twitter-posts`** (after the existing `POST /:id/check-twitter` at lines 433-447):

```js
router.get('/:id/twitter-posts', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const project = await loadProjectOr404(res, id, req.userId);
  if (!project) return;
  const posts = await db.prepare(
    'SELECT id, post_id, author, link, content, published_at, created_at FROM twitter_posts WHERE project_id = ? ORDER BY published_at DESC, id DESC LIMIT 100'
  ).all(id);
  res.json(posts);
});
```

### 6. `public/index.html` — UI toggle

**Form template (around lines 667-673)** — add a "Posts Check" checkbox to the Twitter form-row, mirroring the website pattern at lines 650-657:

```html
<div class="form-row">
  <div class="form-row-header">
    <label>Twitter URL</label>
    <label data-tooltip="Fetch latest posts and alert on new ones" data-placement="top"><input type="checkbox" v-model="f.twitter_posts_check" /> Posts Check</label>
    <label data-tooltip="Check Twitter account existence and account suspension" data-placement="left"><input type="checkbox" v-model="f.twitter_enabled" /> Enabled</label>
  </div>
  <input v-model="f.twitter_url" type="url" placeholder="https://twitter.com/handle" />
</div>
```

**Form state init (line 718-722)** — add `twitter_posts_check: true,` to the initial ref.

**Edit-mode sync (line 735-752)** — add `twitter_posts_check: !!v.twitter_posts_check,` to the assignment block.

**`emit('submit', ...)` (line 811-817)** — add `twitter_posts_check: p.twitter_posts_check,` to the emitted object.

**JSON import mapping (line 2183-2213)** — change the `twitter_enabled` line so it reads from the flat column when present, falling back to JSON `pc` only for legacy data. Also map `pc` to `twitter_posts_check`:

```js
twitter_url:            twitterVal?.url ?? twitterVal ?? null,
twitter_enabled:        item.twitter_enabled !== undefined
  ? (item.twitter_enabled ? 1 : 0)
  : (twitterVal?.pc ?? 1),
twitter_posts_check:    item.twitter_posts_check !== undefined
  ? (item.twitter_posts_check ? 1 : 0)
  : (twitterVal?.pc ?? 1),
```

**Display component (around lines 1027, 1460)** — the existing nitter URL helper there stays as-is; no UI change required for post display in this iteration (post listing is a future feature; the table is populated and queryable via the new API endpoint, but the SPA doesn't need to render them yet).

## Reused functions / patterns

- `fetchWithTimeout` — already in checker.js, reuse for RSS fetch (avoids new fetch wrapper)
- `recordStatusChange(projectId, resourceType, eventType, value)` — checker.js:91, reuse
- `logCheck(projectId, resourceType, resourceId, result)` — checker.js:98, reuse
- `loadProjectOr404(res, id, userId)` — projects.js:26, reuse for the new GET endpoint
- `parseProjectRow` — projects.js:11, fix and reuse
- Migrations runner — services/migrations.js:689, append to `runMigrations`
- Migration table-creator pattern — `add_token_prices_table` at migrations.js:334-355
- CREATE TABLE in db.js — pattern at db.js:50-73 (repos), 139-147 (alert_logs), 149-166 (token_prices)
- `util.promisify` — stdlib, for `rss-to-json`
- `handleFromUrl` — replicate the strip pattern from `public/index.html:1027`

## Verification

1. **DB migration** — `pnpm vacuum && pnpm start`, confirm `twitter_posts` exists:
   ```sql
   SELECT name FROM sqlite_master WHERE type='table' AND name='twitter_posts';
   ```
   Confirm the `UNIQUE (project_id, post_id)` constraint is present:
   ```sql
   SELECT sql FROM sqlite_master WHERE type='table' AND name='twitter_posts';
   ```

2. **Create project with `pc` on** — POST a project with `twitter_url` and `twitter_posts_check: true`, then `GET /:id` and verify `twitter_posts_check === 1` and `twitter_enabled` is the flat-column value (not 0/1 from `pc`).

3. **Update project toggling `pc`** — PUT with `twitter_posts_check: false`, GET, confirm `pc` flipped in `twitter.twitter` JSON. PUT with `twitter_url` only, confirm `pc` preserved from request body if `twitter_posts_check` is also sent, or kept from existing row otherwise.

4. **End-to-end twitter check with new posts** — Use a known-active Twitter handle. Set `pc=1`, trigger `POST /:id/check-twitter`. Verify:
   - `check_logs` has a row with `status='changed'` (or `'ok'` if this is the first run) and `details` contains `{ new_posts: N, post_ids: [...] }` when N > 0
   - `event_logs` has a `changed` row with `value` containing the post ids
   - `twitter_posts` table has rows for that project, no duplicates on re-check (UNIQUE constraint working)
   - The `value` JSON in `event_logs` is the same shape as website content-check events

5. **pc=0 path** — Same project, PUT `twitter_posts_check: false`, trigger check. Verify:
   - `checkTwitter()` does NOT call the RSS path
   - `details` is null, no new `event_logs` rows for posts

6. **`parseProjectRow` regression** — Confirm that on a project with `pc=0` and `twitter_enabled=1` (the legitimate case post-fix), `GET /:id` returns `twitter_enabled: 1, twitter_posts_check: 0`. Pre-fix, the previous code would have returned `twitter_enabled: 0` (wrong).

7. **Alert loop doesn't break** — `pnpm dev`, wait for the 1-min alert tick. The new `changed` event for posts should follow the same alerting rules as the existing website content-change events (alert after `twitter_alert_minutes`, stop after `twitter_alert_stop_minutes`).

8. **First run edge case** — Project with no prior `check_logs`: `lastStatus` is null, so the existing transition logic at checker.js:316-320 won't fire `recordStatusChange` for the new-posts branch's `status='changed'`. Decision: **explicitly call `recordStatusChange(projectId, 'twitter', 'changed', { new_posts, post_ids })` in the new-posts branch** whenever `newPosts > 0`, independent of the transition logic. This guarantees a first-run event even when no baseline exists. (Without this, the first batch of fetched posts is silent in `event_logs`.)

9. **nitter reliability** — Nitter instances go down. If RSS fetch throws or returns 0 items, the twitter HTTP check should still record its own `ok`/`error` result; the posts branch should swallow the error and log to console without failing the parent check. Add a try/catch around the `fetchAndStoreTwitterPosts` call in `checkTwitter`.

10. **Cost note** — The RSS check runs every time `checkTwitter()` runs. For projects that follow many accounts, this is one RSS request per twitter tick. Acceptable; if it becomes a problem, gate on a per-project "last posts check" timestamp in the future.

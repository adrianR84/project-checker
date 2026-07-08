// Cron-based scheduler for periodic checks
const cron = require('node-cron');
const db = require('./db');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck, recordStatusChange } = require('./checker');
const { fetchReposForOwner } = require('./github');
const { sendAlert } = require('./notifications');

const now = () => new Date().toISOString();

let jobs = [];
let initialized = false;
let tokenPriceInterval = null;

/** Stops and clears all scheduled cron jobs. */
function clearJobs() {
  for (const j of jobs) {
    try { j.stop(); } catch (_) {}
  }
  jobs = [];
  if (tokenPriceInterval) { clearInterval(tokenPriceInterval); tokenPriceInterval = null; }
}

/** Converts a minute count into a node-cron expression (e.g. 60 → "0 0/1 * * *"). */
function everyNMinutes(n) {
  const mins = Math.max(1, Math.min(10080, parseInt(n, 10) || 1));
  if (mins < 60) return `*/${mins} * * * *`;
  const hours = Math.round(mins / 60);
  return `0 */${hours} * * *`;
}

/** Runs website checks for all enabled projects, logs results to check_logs. */
async function runWebsiteTick() {
  const projects = await db.prepare(`
    SELECT id, website_url, website_content_check FROM projects
    WHERE enabled = 1 AND website_enabled = 1 AND website_url IS NOT NULL AND website_url != ''
  `).all();
  console.log(`[${now()}] Scheduler: website tick — ${projects.length} projects`);
  for (const p of projects) {
    try {
      const r = await checkWebsite(p.website_url, p.id, !!p.website_content_check);
      await logCheck(p.id, 'website', null, r);
    } catch (err) {
      console.error(`[${now()}] website check failed for project ${p.id}: ${err.message}`);
    }
  }
}

/** Runs Twitter checks for all enabled projects, logs results to check_logs. */
async function runTwitterTick() {
  const projects = await db.prepare(`
    SELECT id, twitter_url FROM projects
    WHERE enabled = 1 AND twitter_enabled = 1 AND twitter_url IS NOT NULL AND twitter_url != ''
  `).all();
  console.log(`[${now()}] Scheduler: twitter tick — ${projects.length} projects`);
  for (const p of projects) {
    try {
      const r = await checkTwitter(p.twitter_url);
      await logCheck(p.id, 'twitter', null, r);
    } catch (err) {
      console.error(`[${now()}] twitter check failed for project ${p.id}: ${err.message}`);
    }
  }
}

/** Fetches GitHub repos for all enabled projects, detects deleted repos (marks status=deleted, records event_logs),
    checks remaining active repos and logs results to check_logs. */
async function runCommitTick() {
  const projects = await db.prepare(`SELECT id, github_url FROM projects WHERE enabled = 1 AND github_enabled = 1 AND github_url IS NOT NULL`).all();
  console.log(`[${now()}] Scheduler: commit tick — ${projects.length} projects`);
  for (const p of projects) {
    try {
      const githubRepos = await fetchReposForOwner(p.github_url);
      const githubFullNames = new Set(githubRepos.map(r => r.full_name));

      const localActiveRepos = await db.prepare(
        'SELECT id, full_name, latest_commit_sha FROM repos WHERE project_id = ? AND status = \'active\''
      ).all(p.id);

      for (const localRepo of localActiveRepos) {
        if (!githubFullNames.has(localRepo.full_name)) {
          const ts = now();
          await db.prepare("UPDATE repos SET status = 'deleted', updated_at = ? WHERE id = ?").run(ts, localRepo.id);
          recordStatusChange(p.id, 'github', 'deleted', { repo_name: localRepo.full_name, sha: localRepo.latest_commit_sha });
        } else {
          const r = await checkGithubRepo(localRepo.full_name, p.id);
          await logCheck(p.id, 'github', localRepo.id, r);
        }
      }
    } catch (err) {
      console.error(`[${now()}] commit tick failed for project ${p.id}: ${err.message}`);
    }
  }
}

/** Deletes check_logs rows older than log_retention_days (daily at midnight). */
async function purgeOldLogs() {
  const settings = await db.config.getSettings();
  if (!settings?.log_retention_days) return;
  const cutoff = new Date(Date.now() - settings.log_retention_days * 86400_000).toISOString();
  await db.prepare('DELETE FROM check_logs WHERE checked_at < ?').run(cutoff);
  console.log(`[${now()}] Scheduler: purged logs older than ${settings.log_retention_days} days`);
}

/** Fires every minute (1-min cron grid). For each resource type:
    - Selects unconfirmed event_logs rows older than *_alert_minutes since their last alert (or never alerted),
      and younger than *_alert_stop_minutes (if set).
    - Inserts one alert_logs row per matched event (recurring alerts at the configured interval).
    - confirmed=1 events are never alerted. */
async function runAlertTick() {
  const [alertIntervals, alertStops] = await Promise.all([
    db.config.getAlertIntervals(),
    db.config.getAlertStops()
  ]);
  if (!alertIntervals || !alertStops) return;

  const types = ['github', 'website', 'twitter'];
  for (const type of types) {
    const interval = alertIntervals[type];
    const stop = alertStops[type];
    if (!interval || interval <= 0) continue;

    const intervalMs = interval * 60_000;
    const cutoffInterval = new Date(Date.now() - intervalMs).toISOString();
    let cutoffStop = null;
    if (stop > 0) {
      cutoffStop = new Date(Date.now() - stop * 60_000).toISOString();
    }

    const conditions = ['rsc.resource_type = ?', 'rsc.confirmed = 0'];
    conditions.push('NOT EXISTS (SELECT 1 FROM alert_logs al WHERE al.status_change_id = rsc.id AND al.created_at >= ?)');
    const params = [type, cutoffInterval];
    if (cutoffStop) {
      conditions.push('rsc.created_at >= ?');
      params.push(cutoffStop);
    }

    const rows = await db.prepare(`
      SELECT rsc.id
      FROM event_logs rsc
      WHERE ${conditions.join(' AND ')}
    `).all(...params);

    const t = now();
    for (const row of rows) {
      await db.prepare("INSERT INTO alert_logs (status_change_id, created_at) VALUES (?, ?)").run(row.id, t);
      // Fire notifications for this alert
      try {
        const ev = await db.prepare(`
          SELECT rsc.*, p.name AS project_name
          FROM event_logs rsc
          LEFT JOIN projects p ON p.id = rsc.project_id
          WHERE rsc.id = ?
        `).get(row.id);
        if (ev) sendAlert(ev, ev.project_name).catch(err => console.error(`[${now()}] sendAlert failed: ${err.message}`));
      } catch (err) {
        console.error(`[${now()}] alert notification dispatch failed: ${err.message}`);
      }
    }

    // Auto-confirm events past their stop window
    if (stop > 0) {
      await db.prepare(`
        UPDATE event_logs SET confirmed = 1
        WHERE resource_type = ? AND confirmed = 0 AND created_at < ?
      `).run(type, cutoffStop);
    }
  }
}

let lastCommitExpr = null, lastWebsiteExpr = null, lastTwitterExpr = null;

const TOKEN_CHECK_INTERVAL_MS = 60_000; // 1 minute, configurable via settings later

/** Fetches token prices from DexScreener for all enabled projects with tokens, in batches of 5. */
async function runTokenPriceTick() {
  const projects = await db.prepare(`
    SELECT id, token FROM projects WHERE enabled = 1 AND token IS NOT NULL AND token != ''
  `).all();
  if (!projects.length) return;
  console.log(`[${now()}] Scheduler: token price tick — ${projects.length} tokens`);

  const BATCH_SIZE = 5;
  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (p) => {
      try {
        const token = JSON.parse(p.token);
        if (!token.contract || !token.chain) return;
        const url = `https://api.dexscreener.com/token-pairs/v1/${token.chain}/${token.contract}`;
        const res = await fetch(url);
        if (res.status === 429) {
          console.warn(`[${now()}] DexScreener rate-limited, pausing 1s before retry`);
          await new Promise(r => setTimeout(r, 1000));
          const retry = await fetch(url);
          if (!retry.ok) return;
          const data = await retry.json();
          await upsertTokenPrice(p.id, token, data);
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        await upsertTokenPrice(p.id, token, data);
      } catch (err) {
        console.error(`[${now()}] token price fetch failed for project ${p.id}: ${err.message}`);
      }
    }));
  }
}

/** Finds the best pair (highest liquidity) from DexScreener response and upserts into token_prices. */
async function upsertTokenPrice(projectId, token, data) {
  const pairs = Array.isArray(data) ? data : [];
  const matched = pairs.filter(p => p.baseToken?.address === token.contract);
  const pair = matched.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!pair) return;
  const ts = now();
  await db.prepare(`
    INSERT INTO token_prices (project_id, symbol, chain, contract, price_usd,
      price_change_h1, price_change_h4, price_change_h6, price_change_h24,
      liquidity_usd, volume_h24, market_cap, pair_created_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      symbol = excluded.symbol, chain = excluded.chain, contract = excluded.contract,
      price_usd = excluded.price_usd, price_change_h1 = excluded.price_change_h1,
      price_change_h4 = excluded.price_change_h4, price_change_h6 = excluded.price_change_h6,
      price_change_h24 = excluded.price_change_h24, liquidity_usd = excluded.liquidity_usd,
      volume_h24 = excluded.volume_h24, market_cap = excluded.market_cap,
      pair_created_at = excluded.pair_created_at, fetched_at = excluded.fetched_at
  `).run(
    projectId,
    pair.baseToken?.symbol || token.symbol || null,
    pair.chainId || token.chain || null,
    token.contract,
    pair.priceUsd || null,
    pair.priceChange?.h1 || null,
    pair.priceChange?.h4 || null,
    pair.priceChange?.h6 || null,
    pair.priceChange?.h24 || null,
    pair.liquidity?.usd || null,
    pair.volume?.h24 || null,
    pair.marketCap || null,
    pair.pairCreatedAt || null,
    ts
  );
}

/** Rebuilds all cron schedules from current config. Only rebuilds if any expression changed.
    Also schedules: daily log purge (midnight) and alert tick (every 1 min, interval-throttled). */
async function reschedule() {
  const intervals = await db.config.getCheckIntervals();
  if (!intervals) {
    console.warn(`[${now()}] Scheduler: no config row found, skipping schedule`);
    return;
  }

  const commitExpr  = everyNMinutes(intervals.github);
  const websiteExpr = everyNMinutes(intervals.website);
  const twitterExpr = everyNMinutes(intervals.twitter);

  const changed = commitExpr !== lastCommitExpr
    || websiteExpr !== lastWebsiteExpr
    || twitterExpr !== lastTwitterExpr;

  if (!changed) return;

  clearJobs();

  if (cron.validate(commitExpr)) {
    const j = cron.schedule(commitExpr, () => { runCommitTick().catch(err => console.error(err)); });
    jobs.push(j);
  }
  lastCommitExpr = commitExpr;
  console.log(`[${now()}] Scheduler: commit job → "${commitExpr}" (every ${intervals.github}min)`);

  if (cron.validate(websiteExpr)) {
    const j = cron.schedule(websiteExpr, () => { runWebsiteTick().catch(err => console.error(err)); });
    jobs.push(j);
  }
  lastWebsiteExpr = websiteExpr;
  console.log(`[${now()}] Scheduler: website job → "${websiteExpr}" (every ${intervals.website}min)`);

  if (cron.validate(twitterExpr)) {
    const j = cron.schedule(twitterExpr, () => { runTwitterTick().catch(err => console.error(err)); });
    jobs.push(j);
  }
  lastTwitterExpr = twitterExpr;
  console.log(`[${now()}] Scheduler: twitter job → "${twitterExpr}" (every ${intervals.twitter}min)`);

  const purgeExpr = '0 0 * * *';
  const purgeJob = cron.schedule(purgeExpr, () => { purgeOldLogs().catch(err => console.error(err)); });
  jobs.push(purgeJob);
  console.log(`[${now()}] Scheduler: log purge job → "${purgeExpr}" (daily at midnight)`);

  // Alert tick: every minute (1-min grid, throttled by config interval inside runAlertTick)
  const alertJob = cron.schedule('* * * * *', () => { runAlertTick().catch(err => console.error(err)); });
  jobs.push(alertJob);
  console.log(`[${now()}] Scheduler: alert tick job → "* * * * *" (1-min grid)`);

  // Token price tick: every TOKEN_CHECK_INTERVAL_MS ms via setInterval (not cron, for rate-limit control)
  clearInterval(tokenPriceInterval);
  tokenPriceInterval = setInterval(() => { runTokenPriceTick().catch(err => console.error(err)); }, TOKEN_CHECK_INTERVAL_MS);
  console.log(`[${now()}] Scheduler: token price tick → every ${TOKEN_CHECK_INTERVAL_MS / 1000}s`);
}

function init() {
  if (initialized) {
    reschedule();
    return;
  }
  initialized = true;
  reschedule();
  runTokenPriceTick().catch(err => console.error(`[${now()}] initial token price tick failed: ${err.message}`));

  setInterval(() => {
    reschedule();
  }, 5 * 60 * 1000);

  console.log(`[${now()}] Scheduler initialized`);
}

module.exports = { init, purgeOldLogs };

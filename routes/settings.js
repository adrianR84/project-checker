// Settings REST API (per-user config + trigger-all)
const express = require('express');
const db = require('../services/db');
const logger = require('../utils/logger');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck } = require('../services/checker');
require('../types'); // JSDoc typedefs only — loaded for editor autocomplete, has no runtime effect

const router = express.Router();
const now = () => new Date().toISOString();

const DUMMY_GITHUB_TOKEN     = 'DUMMY_TOKEN_github';
const DUMMY_API_TOKEN        = 'DUMMY_TOKEN_api';
const DUMMY_TELEGRAM_TOKEN   = 'DUMMY_TOKEN_telegram';
const DUMMY_TELEGRAM_CHAT_ID = 'DUMMY_TOKEN_telegram_chat_id';
const DUMMY_PUSHBULLET_TOKEN = 'DUMMY_TOKEN_pushbullet';
const DUMMY_WEBSHARE_TOKEN   = 'DUMMY_TOKEN_webshare';

// GET /api/settings
router.get('/', async (req, res) => {
  await db.ensureConfig(req.userId);
  const [settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet, price_alerts, webshare] = await Promise.all([
    db.config.getSettings(req.userId),
    db.config.getCheckIntervals(req.userId),
    db.config.getAlertIntervals(req.userId),
    db.config.getAlertStops(req.userId),
    db.config.getTelegram(req.userId),
    db.config.getPushbullet(req.userId),
    db.config.getPriceAlerts(req.userId),
    db.config.getWebshare(req.userId)
  ]);
  if (!settings) return res.status(500).json({ error: 'config not found' });
  // Return flat shape for frontend compatibility
  res.json({
    log_retention_days:          settings.log_retention_days,
    event_log_retention_days:   settings.event_log_retention_days ?? 14,
    alert_log_retention_days:   settings.alert_log_retention_days ?? 14,
    twitter_posts_per_project:  settings.twitter_posts_per_project ?? 50,
    twitter_nitter_instance:    settings.twitter_nitter_instance || 'https://nitter.net',
    ui_refresh_seconds:         settings.ui_refresh_seconds,
    compact_activity:           settings.compact_activity_display,
    github_token:               settings.github_token ? DUMMY_GITHUB_TOKEN : '',
    api_token:                 settings.api_token    ? DUMMY_API_TOKEN    : '',
    logs_per_page:             settings.logs_per_page,
    checks_on_new_project:      settings.checks_on_new_project ?? 1,
    system_pause:               settings.system_pause ?? 0,
    github_check_minutes:       check_intervals.github,
    website_check_minutes:      check_intervals.website,
    twitter_check_minutes:      check_intervals.twitter,
    github_alert_minutes:       alert_intervals.github,
    website_alert_minutes:      alert_intervals.website,
    twitter_alert_minutes:      alert_intervals.twitter,
    github_alert_stop_minutes:  alert_stops.github,
    website_alert_stop_minutes:  alert_stops.website,
    twitter_alert_stop_minutes:  alert_stops.twitter,
    settings,
    check_intervals,
    alert_intervals,
    alert_stops,
    telegram: telegram ? { ...telegram, bot_token: telegram.bot_token ? DUMMY_TELEGRAM_TOKEN : '', chat_id: telegram.chat_id ? DUMMY_TELEGRAM_CHAT_ID : '' } : null,
    pushbullet: pushbullet ? { ...pushbullet, access_token: pushbullet.access_token ? DUMMY_PUSHBULLET_TOKEN : '' } : null,
    price_alerts,
    webshare: webshare ? { ...webshare, token: webshare.token ? DUMMY_WEBSHARE_TOKEN : '' } : null,
  });
});

// GET /api/settings/proxy-stats — return per-proxy stats
router.get('/proxy-stats', async (req, res) => {
  const stats = await db.config.getProxyStats();
  res.json(stats);
});

// DELETE /api/settings/proxy-stats — clear all stats
router.delete('/proxy-stats', async (req, res) => {
  await db.config.clearProxyStats();
  res.json({ ok: true });
});

// PUT /api/settings — update check intervals and log retention
router.put('/', async (req, res) => {
  await db.ensureConfig(req.userId);
  const updates = {};

  // Backward compat: accept commit_check_minutes → github_check_minutes
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'commit_check_minutes')) {
    const v = parseInt(req.body.commit_check_minutes, 10);
    if (!Number.isFinite(v) || v < 1 || v > 10080) {
      return res.status(400).json({ error: 'commit_check_minutes must be an integer between 1 and 10080' });
    }
    updates.github_check_minutes = v;
  }

  const checkKeys = ['github_check_minutes', 'website_check_minutes', 'twitter_check_minutes'];
  for (const key of checkKeys) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      const v = parseInt(req.body[key], 10);
      if (!Number.isFinite(v) || v < 1 || v > 10080) {
        return res.status(400).json({ error: `${key} must be an integer between 1 and 10080` });
      }
      updates[key] = v;
    }
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'log_retention_days')) {
    const v = parseInt(req.body.log_retention_days, 10);
    if (!Number.isFinite(v) || v < 1 || v > 7) {
      return res.status(400).json({ error: 'log_retention_days must be an integer between 1 and 7' });
    }
    updates.log_retention_days = v;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'event_log_retention_days')) {
    const v = parseInt(req.body.event_log_retention_days, 10);
    if (!Number.isFinite(v) || v < 10 || v > 60) {
      return res.status(400).json({ error: 'event_log_retention_days must be an integer between 10 and 60' });
    }
    updates.event_log_retention_days = v;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'alert_log_retention_days')) {
    const v = parseInt(req.body.alert_log_retention_days, 10);
    if (!Number.isFinite(v) || v < 10 || v > 30) {
      return res.status(400).json({ error: 'alert_log_retention_days must be an integer between 10 and 30' });
    }
    updates.alert_log_retention_days = v;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'twitter_posts_per_project')) {
    const v = parseInt(req.body.twitter_posts_per_project, 10);
    if (!Number.isFinite(v) || v < 50 || v > 100) {
      return res.status(400).json({ error: 'twitter_posts_per_project must be an integer between 50 and 100' });
    }
    updates.twitter_posts_per_project = v;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'twitter_nitter_instance')) {
    updates.twitter_nitter_instance = req.body.twitter_nitter_instance;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'ui_refresh_seconds')) {
    const v = parseInt(req.body.ui_refresh_seconds, 10);
    if (!Number.isFinite(v) || v < 0 || v > 300) {
      return res.status(400).json({ error: 'ui_refresh_seconds must be an integer between 0 and 300' });
    }
    updates.ui_refresh_seconds = v;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'compact_activity')) {
    const v = req.body.compact_activity;
    updates.compact_activity = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'checks_on_new_project')) {
    const v = req.body.checks_on_new_project;
    updates.checks_on_new_project = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
  }

  // Alert config keys
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'github_token')) {
    const t = String(req.body.github_token || '');
    if (t && t !== DUMMY_GITHUB_TOKEN) updates.github_token = t;
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'api_token')) {
    const t = String(req.body.api_token || '');
    if (t && t !== DUMMY_API_TOKEN) updates.api_token = t;
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'logs_per_page')) {
    updates.logs_per_page = Math.max(5, Math.min(100, parseInt(req.body.logs_per_page, 10) || 20));
  }

  const alertKeys = [
    'github_alert_minutes', 'github_alert_stop_minutes',
    'website_alert_minutes', 'website_alert_stop_minutes',
    'twitter_alert_minutes', 'twitter_alert_stop_minutes',
  ];
  for (const key of alertKeys) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, key)) {
      const v = parseInt(req.body[key], 10);
      if (!Number.isFinite(v) || v < 0 || v > 10080) {
        return res.status(400).json({ error: `${key} must be an integer between 0 and 10080` });
      }
      updates[key] = v;
    }
  }

  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'system_pause')) {
    const v = req.body.system_pause;
    updates.system_pause = (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
  }

  if (Object.keys(updates).length === 0 && !req.body?.telegram && !req.body?.pushbullet && !req.body?.price_alerts && !req.body?.webshare) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // price_alerts { alerts: [{ price_change, price_interval, enabled, telegram, pushbullet, log }, ...] }
  if (req.body?.price_alerts && typeof req.body.price_alerts === 'object') {
    const cur = await db.config.getPriceAlerts();
    if (cur) {
      const incoming = req.body.price_alerts;
      const merged = {
        alerts: (incoming.alerts && Array.isArray(incoming.alerts))
          ? incoming.alerts.map((a, i) => ({
              price_for:      typeof a.price_for === 'string' ? a.price_for : cur.alerts[i]?.price_for ?? '6h',
              price_change:   typeof a.price_change === 'number' ? a.price_change : cur.alerts[i]?.price_change ?? 10,
              price_interval: typeof a.price_interval === 'number' ? a.price_interval : cur.alerts[i]?.price_interval ?? 5,
              enabled:        a.enabled === 1 || a.enabled === 0 ? a.enabled : (cur.alerts[i]?.enabled ?? 1),
              telegram:       a.telegram === 1 || a.telegram === 0 ? a.telegram : (cur.alerts[i]?.telegram ?? 1),
              pushbullet:     a.pushbullet === 1 || a.pushbullet === 0 ? a.pushbullet : (cur.alerts[i]?.pushbullet ?? 0),
              log:            a.log === 1 || a.log === 0 ? a.log : (cur.alerts[i]?.log ?? 1),
            }))
          : cur.alerts
      };
      await db.prepare('UPDATE config SET price_alerts = ? WHERE user_id = ?').run(JSON.stringify(merged), req.userId);
    }
  }

  // telegram { bot_token, chat_id, enabled }
  if (req.body?.telegram && typeof req.body.telegram === 'object') {
    const cur = await db.config.getTelegram();
    if (cur) {
      const incoming = req.body.telegram;
      const merged = {
        bot_token: (incoming.bot_token && incoming.bot_token !== DUMMY_TELEGRAM_TOKEN) ? incoming.bot_token : cur.bot_token,
        chat_id:   (incoming.chat_id && incoming.chat_id !== DUMMY_TELEGRAM_CHAT_ID) ? incoming.chat_id : cur.chat_id,
        enabled:   incoming.enabled === true || incoming.enabled === 1 || incoming.enabled === 'true'
      };
      await db.prepare('UPDATE config SET telegram = ? WHERE user_id = ?').run(JSON.stringify(merged), req.userId);
    }
  }

  // pushbullet { access_token, enabled }
  if (req.body?.pushbullet && typeof req.body.pushbullet === 'object') {
    const cur = await db.config.getPushbullet();
    if (cur) {
      const incoming = req.body.pushbullet;
      const merged = {
        access_token: (incoming.access_token && incoming.access_token !== DUMMY_PUSHBULLET_TOKEN) ? incoming.access_token : cur.access_token,
        enabled:      incoming.enabled === true || incoming.enabled === 1 || incoming.enabled === 'true'
      };
      await db.prepare('UPDATE config SET pushbullet = ? WHERE user_id = ?').run(JSON.stringify(merged), req.userId);
    }
  }

  // webshare { enabled, token, country }
  if (req.body?.webshare && typeof req.body.webshare === 'object') {
    const cur = await db.config.getWebshare(req.userId);
    const incoming = req.body.webshare;
    const merged = {
      enabled:  !!(incoming.enabled),
      token:   typeof incoming.token === 'string' && incoming.token !== '' && incoming.token !== DUMMY_WEBSHARE_TOKEN ? incoming.token : (cur?.token ?? null),
      country: typeof incoming.country === 'string' ? incoming.country.trim() : (cur?.country ?? ''),
    };
    await db.config.saveWebshare(req.userId, merged);
  }

  // Flat columns no longer exist — update JSON groups directly
  if (updates.github_check_minutes || updates.website_check_minutes || updates.twitter_check_minutes) {
    const ci = await db.config.getCheckIntervals(req.userId);
    if (ci) {
      if (updates.github_check_minutes) ci.github = updates.github_check_minutes;
      if (updates.website_check_minutes) ci.website = updates.website_check_minutes;
      if (updates.twitter_check_minutes) ci.twitter = updates.twitter_check_minutes;
      await db.prepare('UPDATE config SET check_intervals = ? WHERE user_id = ?').run(JSON.stringify(ci), req.userId);
    }
  }
  if (updates.log_retention_days || updates.event_log_retention_days || updates.alert_log_retention_days || updates.ui_refresh_seconds || updates.compact_activity !== undefined || updates.github_token !== undefined || updates.logs_per_page !== undefined || updates.checks_on_new_project !== undefined || updates.twitter_posts_per_project !== undefined || updates.twitter_nitter_instance !== undefined || updates.system_pause !== undefined) {
    const s = await db.config.getSettings(req.userId);
    if (s) {
      if (updates.log_retention_days !== undefined) s.log_retention_days = updates.log_retention_days;
      if (updates.event_log_retention_days !== undefined) s.event_log_retention_days = updates.event_log_retention_days;
      if (updates.alert_log_retention_days !== undefined) s.alert_log_retention_days = updates.alert_log_retention_days;
      if (updates.ui_refresh_seconds !== undefined) s.ui_refresh_seconds = updates.ui_refresh_seconds;
      if (updates.compact_activity !== undefined) s.compact_activity_display = updates.compact_activity;
      if (updates.github_token !== undefined) s.github_token = updates.github_token || null;
      if (updates.api_token !== undefined) s.api_token = updates.api_token || null;
      if (updates.logs_per_page !== undefined) s.logs_per_page = updates.logs_per_page;
      if (updates.checks_on_new_project !== undefined) s.checks_on_new_project = updates.checks_on_new_project;
      if (updates.twitter_posts_per_project !== undefined) s.twitter_posts_per_project = updates.twitter_posts_per_project;
      if (updates.twitter_nitter_instance !== undefined) s.twitter_nitter_instance = updates.twitter_nitter_instance;
      if (updates.system_pause !== undefined) s.system_pause = updates.system_pause;
      await db.prepare('UPDATE config SET settings = ? WHERE user_id = ?').run(JSON.stringify(s), req.userId);
    }
  }
  if (alertKeys.some(k => updates[k])) {
    const ai = await db.config.getAlertIntervals(req.userId);
    const as = await db.config.getAlertStops(req.userId);
    if (ai || as) {
      const typeMap = { github_alert_minutes: 'github', website_alert_minutes: 'website', twitter_alert_minutes: 'twitter' };
      const stopMap = { github_alert_stop_minutes: 'github', website_alert_stop_minutes: 'website', twitter_alert_stop_minutes: 'twitter' };
      for (const [k, type] of Object.entries(typeMap)) { if (updates[k] !== undefined && ai) ai[type] = updates[k]; }
      for (const [k, type] of Object.entries(stopMap)) { if (updates[k] !== undefined && as) as[type] = updates[k]; }
      if (ai) await db.prepare('UPDATE config SET alert_intervals = ? WHERE user_id = ?').run(JSON.stringify(ai), req.userId);
      if (as) await db.prepare('UPDATE config SET alert_stops = ? WHERE user_id = ?').run(JSON.stringify(as), req.userId);
    }
  }

  const cfg = await db.prepare('SELECT * FROM config WHERE user_id = ?').get(req.userId);
  const [settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet, price_alerts] = await Promise.all([
    db.config.getSettings(req.userId),
    db.config.getCheckIntervals(req.userId),
    db.config.getAlertIntervals(req.userId),
    db.config.getAlertStops(req.userId),
    db.config.getTelegram(req.userId),
    db.config.getPushbullet(req.userId),
    db.config.getPriceAlerts(req.userId)
  ]);
  logger.info('settings', `Settings updated: ${JSON.stringify(updates)}`);
  res.json({ ...cfg, settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet, price_alerts });
});

/**
 * Parse a raw project row: expand JSON group cols back to flat names.
 * @param {object|null} row - Raw project DB row
 * @returns {object} Flattened project with website_url, github_url, twitter_url, etc.
 */
function parseProjectRow(row) {
  if (!row) return row;
  /** @type {import('../types').ProjectWebsite} */
  const w = row.website  ? JSON.parse(row.website) : { url: null, cc: 1 };
  /** @type {import('../types').ProjectGithub} */
  const g = row.github   ? JSON.parse(row.github)  : { url: null };
  /** @type {import('../types').ProjectTwitter} */
  const t = row.twitter  ? JSON.parse(row.twitter) : { url: null, pc: 1 };
  /** @type {import('../types').ProjectTelegram} */
  const tg = row.telegram ? JSON.parse(row.telegram) : { url: null };
  return {
    ...row,
    website_url:           w.url,
    website_content_check: w.cc ?? 1,
    github_url:           g.url,
    twitter_url:          t.url,
    twitter_enabled:      row.twitter_enabled,
    twitter_posts_check:  t.pc ?? 1,
    telegram_url:         tg.url,
    price_enabled:        row.token_enabled,
  };
}

/**
 * Runs all enabled checks for one project and logs results.
 * @param {object} project - Parsed project row (via parseProjectRow)
 * @returns {{ website: object|null, github: Array, twitter: object|null }}
 */
async function runChecksForProject(project) {
  project = parseProjectRow(project);
  const results = { website: null, github: [], twitter: null };

  if (project.website_enabled && project.website_url) {
    const r = await checkWebsite(project.website_url);
    await logCheck(project.id, 'website', null, r);
    results.website = r;
  }

  if (project.twitter_enabled && project.twitter_url) {
    const r = await checkTwitter(project.twitter_url);
    await logCheck(project.id, 'twitter', null, r);
    results.twitter = r;
  }

  if (project.github_enabled) {
    const repos = await db.prepare('SELECT * FROM repos WHERE project_id = ?').all(project.id);
    for (const repo of repos) {
      const r = await checkGithubRepo(repo.full_name, project.id);
      await logCheck(project.id, 'github', repo.id, r);
      results.github.push({ repo: repo.full_name, ...r });
    }
  }

  return results;
}

// POST /api/settings/trigger-all
router.post('/trigger-all', async (req, res) => {
  const projects = await db.prepare('SELECT * FROM projects WHERE user_id = ?').all(req.userId);
  logger.info('settings', `Triggering all checks for ${projects.length} projects`);
  const allResults = [];
  for (const project of projects) {
    try {
      const r = await runChecksForProject(project);
      allResults.push({ project_id: project.id, name: project.name, results: r });
    } catch (err) {
      logger.error('settings', `trigger-all failed for project ${project.id}:`, err);
      allResults.push({ project_id: project.id, name: project.name, error: err.message });
    }
  }
  res.json({ ok: true, triggered: allResults.length, results: allResults });
});

/**
 * Runs checks for a single resource type across all projects owned by a user.
 * @param {'website'|'github'|'twitter'} resourceType
 * @param {number} userId
 * @returns {Array<{project_id, name, result?, error?}>}
 */
async function triggerResourceType(resourceType, userId) {
  const projects = await db.prepare('SELECT * FROM projects WHERE user_id = ?').all(userId);
  const results = [];
  for (const raw of projects) {
    const project = parseProjectRow(raw);
    try {
      if (resourceType === 'website' && project.website_enabled && project.website_url) {
        const r = await checkWebsite(project.website_url);
        await logCheck(project.id, 'website', null, r);
        results.push({ project_id: project.id, name: project.name, result: r });
      } else if (resourceType === 'twitter' && project.twitter_enabled && project.twitter_url) {
        const r = await checkTwitter(project.twitter_url, null, { postsCheck: true });
        await logCheck(project.id, 'twitter', null, r);
        results.push({ project_id: project.id, name: project.name, result: r });
      } else if (resourceType === 'github' && project.github_enabled) {
        const repos = await db.prepare("SELECT * FROM repos WHERE project_id = ? AND status = 'active'").all(project.id);
        for (const repo of repos) {
          const r = await checkGithubRepo(repo.full_name, project.id);
          await logCheck(project.id, 'github', repo.id, r);
          results.push({ project_id: project.id, name: project.name, repo: repo.full_name, result: r });
        }
      }
    } catch (err) {
      logger.error('settings', `trigger(${resourceType}) failed for project ${project.id}:`, err);
      results.push({ project_id: project.id, name: project.name, error: err.message });
    }
  }
  return results;
}

// POST /api/settings/trigger-websites
router.post('/trigger-websites', async (req, res) => {
  logger.info('settings', 'Manual trigger: websites');
  const results = await triggerResourceType('website', req.userId);
  res.json({ ok: true, triggered: results.length, results });
});

// POST /api/settings/trigger-github
router.post('/trigger-github', async (req, res) => {
  logger.info('settings', 'Manual trigger: github');
  const results = await triggerResourceType('github', req.userId);
  res.json({ ok: true, triggered: results.length, results });
});

// POST /api/settings/trigger-twitter
router.post('/trigger-twitter', async (req, res) => {
  logger.info('settings', 'Manual trigger: twitter');
  const results = await triggerResourceType('twitter', req.userId);
  res.json({ ok: true, triggered: results.length, results });
});

// POST /api/settings/clear-data — empty all tables except config
router.post('/clear-data', async (req, res) => {
  // Cascade through user's projects — repos/check_logs/event_logs are FK-deleted
  await db.prepare('DELETE FROM projects WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

// POST /api/settings/clear-logs — delete all check logs and status changes for user's projects
router.post('/clear-logs', async (req, res) => {
  const projectIds = await db.prepare('SELECT id FROM projects WHERE user_id = ?').all(req.userId);
  const ids = projectIds.map(p => p.id);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM check_logs WHERE project_id IN (${placeholders})`).run(...ids);
    await db.prepare(`DELETE FROM event_logs WHERE project_id IN (${placeholders})`).run(...ids);
    await db.prepare(`DELETE FROM alert_logs WHERE status_change_id IN (SELECT id FROM event_logs WHERE project_id IN (${placeholders}))`).run(...ids);
  }
  res.json({ ok: true });
});

// POST /api/settings/clear-alert-logs — delete all alert logs for user's projects
router.post('/clear-alert-logs', async (req, res) => {
  const projectIds = await db.prepare('SELECT id FROM projects WHERE user_id = ?').all(req.userId);
  const ids = projectIds.map(p => p.id);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`DELETE FROM alert_logs WHERE status_change_id IN (SELECT id FROM event_logs WHERE project_id IN (${placeholders}))`).run(...ids);
  }
  res.json({ ok: true });
});

// POST /api/settings/generate-api-token — generate and save a new PC_ token
router.post('/generate-api-token', async (req, res) => {
  const { randomBytes } = require('crypto');
  const token = 'PC_' + randomBytes(32).toString('hex');
  const s = await db.config.getSettings(req.userId);
  if (s) {
    s.api_token = token;
    await db.prepare('UPDATE config SET settings = ? WHERE user_id = ?').run(JSON.stringify(s), req.userId);
  }
  res.json({ api_token: token });
});

module.exports = router;

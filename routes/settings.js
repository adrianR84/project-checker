// Settings REST API (config singleton + trigger-all)
const express = require('express');
const db = require('../services/db');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck } = require('../services/checker');

const router = express.Router();
const now = () => new Date().toISOString();

// GET /api/settings
router.get('/', async (req, res) => {
  const [settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet] = await Promise.all([
    db.config.getSettings(),
    db.config.getCheckIntervals(),
    db.config.getAlertIntervals(),
    db.config.getAlertStops(),
    db.config.getTelegram(),
    db.config.getPushbullet()
  ]);
  if (!settings) return res.status(500).json({ error: 'config not found' });
  // Return flat shape for frontend compatibility
  res.json({
    log_retention_days:         settings.log_retention_days,
    ui_refresh_seconds:         settings.ui_refresh_seconds,
    compact_activity:           settings.compact_activity_display,
    github_token:               settings.github_token,
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
    telegram,
    pushbullet,
  });
});

// PUT /api/settings — update check intervals and log retention
router.put('/', async (req, res) => {
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
    if (!Number.isFinite(v) || v < 0 || v > 365) {
      return res.status(400).json({ error: 'log_retention_days must be an integer between 0 and 365' });
    }
    updates.log_retention_days = v;
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

  // Alert config keys
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'github_token')) {
    updates.github_token = String(req.body.github_token || '');
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

  if (Object.keys(updates).length === 0 && !req.body?.telegram && !req.body?.pushbullet) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // telegram { bot_token, chat_id, enabled }
  if (req.body?.telegram && typeof req.body.telegram === 'object') {
    const cur = await db.config.getTelegram();
    if (cur) {
      const incoming = req.body.telegram;
      const merged = {
        bot_token: typeof incoming.bot_token === 'string' ? incoming.bot_token : cur.bot_token,
        chat_id:   typeof incoming.chat_id   === 'string' ? incoming.chat_id   : cur.chat_id,
        enabled:   incoming.enabled === true || incoming.enabled === 1 || incoming.enabled === 'true'
      };
      await db.prepare('UPDATE config SET telegram = ? WHERE id = 1').run(JSON.stringify(merged));
    }
  }

  // pushbullet { access_token, enabled }
  if (req.body?.pushbullet && typeof req.body.pushbullet === 'object') {
    const cur = await db.config.getPushbullet();
    if (cur) {
      const incoming = req.body.pushbullet;
      const merged = {
        access_token: typeof incoming.access_token === 'string' ? incoming.access_token : cur.access_token,
        enabled:      incoming.enabled === true || incoming.enabled === 1 || incoming.enabled === 'true'
      };
      await db.prepare('UPDATE config SET pushbullet = ? WHERE id = 1').run(JSON.stringify(merged));
    }
  }

  // Flat columns no longer exist — update JSON groups directly
  if (updates.github_check_minutes || updates.website_check_minutes || updates.twitter_check_minutes) {
    const ci = await db.config.getCheckIntervals();
    if (ci) {
      if (updates.github_check_minutes) ci.github = updates.github_check_minutes;
      if (updates.website_check_minutes) ci.website = updates.website_check_minutes;
      if (updates.twitter_check_minutes) ci.twitter = updates.twitter_check_minutes;
      await db.prepare('UPDATE config SET check_intervals = ? WHERE id = 1').run(JSON.stringify(ci));
    }
  }
  if (updates.log_retention_days || updates.ui_refresh_seconds || updates.compact_activity !== undefined || updates.github_token !== undefined) {
    const s = await db.config.getSettings();
    if (s) {
      if (updates.log_retention_days !== undefined) s.log_retention_days = updates.log_retention_days;
      if (updates.ui_refresh_seconds !== undefined) s.ui_refresh_seconds = updates.ui_refresh_seconds;
      if (updates.compact_activity !== undefined) s.compact_activity_display = updates.compact_activity;
      if (updates.github_token !== undefined) s.github_token = updates.github_token || null;
      await db.prepare('UPDATE config SET settings = ? WHERE id = 1').run(JSON.stringify(s));
    }
  }
  if (alertKeys.some(k => updates[k])) {
    const ai = await db.config.getAlertIntervals();
    const as = await db.config.getAlertStops();
    if (ai || as) {
      const typeMap = { github_alert_minutes: 'github', website_alert_minutes: 'website', twitter_alert_minutes: 'twitter' };
      const stopMap = { github_alert_stop_minutes: 'github', website_alert_stop_minutes: 'website', twitter_alert_stop_minutes: 'twitter' };
      for (const [k, type] of Object.entries(typeMap)) { if (updates[k] !== undefined && ai) ai[type] = updates[k]; }
      for (const [k, type] of Object.entries(stopMap)) { if (updates[k] !== undefined && as) as[type] = updates[k]; }
      if (ai) await db.prepare('UPDATE config SET alert_intervals = ? WHERE id = 1').run(JSON.stringify(ai));
      if (as) await db.prepare('UPDATE config SET alert_stops = ? WHERE id = 1').run(JSON.stringify(as));
    }
  }

  const cfg = await db.prepare('SELECT * FROM config WHERE id = 1').get();
  const [settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet] = await Promise.all([
    db.config.getSettings(),
    db.config.getCheckIntervals(),
    db.config.getAlertIntervals(),
    db.config.getAlertStops(),
    db.config.getTelegram(),
    db.config.getPushbullet()
  ]);
  console.log(`[${now()}] Settings updated: ${JSON.stringify(updates)}`);
  res.json({ ...cfg, settings, check_intervals, alert_intervals, alert_stops, telegram, pushbullet });
});

// Run checks for a single project across enabled resources
/** Runs all enabled checks for one project and logs results. */
async function runChecksForProject(project) {
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
  const projects = await db.prepare('SELECT * FROM projects').all();
  console.log(`[${now()}] Triggering all checks for ${projects.length} projects`);
  const allResults = [];
  for (const project of projects) {
    try {
      const r = await runChecksForProject(project);
      allResults.push({ project_id: project.id, name: project.name, results: r });
    } catch (err) {
      console.error(`[${now()}] trigger-all failed for project ${project.id}: ${err.message}`);
      allResults.push({ project_id: project.id, name: project.name, error: err.message });
    }
  }
  res.json({ ok: true, triggered: allResults.length, results: allResults });
});

// Trigger a specific resource type across all projects
/** Runs checks for a single resource type across all projects. */
async function triggerResourceType(resourceType) {
  const projects = await db.prepare('SELECT * FROM projects').all();
  const results = [];
  for (const project of projects) {
    try {
      if (resourceType === 'website' && project.website_enabled && project.website_url) {
        const r = await checkWebsite(project.website_url);
        await logCheck(project.id, 'website', null, r);
        results.push({ project_id: project.id, name: project.name, result: r });
      } else if (resourceType === 'twitter' && project.twitter_enabled && project.twitter_url) {
        const r = await checkTwitter(project.twitter_url);
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
      console.error(`[${now()}] trigger(${resourceType}) failed for project ${project.id}: ${err.message}`);
      results.push({ project_id: project.id, name: project.name, error: err.message });
    }
  }
  return results;
}

// POST /api/settings/trigger-websites
router.post('/trigger-websites', async (req, res) => {
  console.log(`[${now()}] Manual trigger: websites`);
  const results = await triggerResourceType('website');
  res.json({ ok: true, triggered: results.length, results });
});

// POST /api/settings/trigger-github
router.post('/trigger-github', async (req, res) => {
  console.log(`[${now()}] Manual trigger: github`);
  const results = await triggerResourceType('github');
  res.json({ ok: true, triggered: results.length, results });
});

// POST /api/settings/trigger-twitter
router.post('/trigger-twitter', async (req, res) => {
  console.log(`[${now()}] Manual trigger: twitter`);
  const results = await triggerResourceType('twitter');
  res.json({ ok: true, triggered: results.length, results });
});

// POST /api/settings/clear-data — empty all tables except config
router.post('/clear-data', async (req, res) => {
  await db.prepare('DELETE FROM event_logs').run();
  await db.prepare('DELETE FROM check_logs').run();
  await db.prepare('DELETE FROM repos').run();
  await db.prepare('DELETE FROM projects').run();
  res.json({ ok: true });
});

// POST /api/settings/clear-logs — delete all check logs and status changes
router.post('/clear-logs', async (req, res) => {
  await db.prepare('DELETE FROM event_logs').run();
  await db.prepare('DELETE FROM check_logs').run();
  await db.prepare('DELETE FROM alert_logs').run();
  res.json({ ok: true });
});

// POST /api/settings/clear-alert-logs — delete all alert logs
router.post('/clear-alert-logs', async (req, res) => {
  await db.prepare('DELETE FROM alert_logs').run();
  res.json({ ok: true });
});

module.exports = router;

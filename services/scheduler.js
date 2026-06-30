// Cron-based scheduler for periodic checks
const cron = require('node-cron');
const db = require('../db');
const { checkWebsite, checkGithubRepo, checkTwitter, logCheck } = require('./checker');

const now = () => new Date().toISOString();

let jobs = [];
let initialized = false;

function clearJobs() {
  for (const j of jobs) {
    try { j.stop(); } catch (_) {}
  }
  jobs = [];
}

// Build a cron expression for every N hours: "0 0 */N * * *"
function everyNHours(n) {
  const hours = Math.max(1, Math.min(23, parseInt(n, 10) || 1));
  return `0 0 */${hours} * *`;
}

// Run website checks for all enabled projects
async function runWebsiteTick() {
  const projects = db.prepare(`
    SELECT id, website_url FROM projects
    WHERE website_enabled = 1 AND website_url IS NOT NULL AND website_url != ''
  `).all();
  console.log(`[${now()}] Scheduler: website tick — ${projects.length} projects`);
  for (const p of projects) {
    try {
      const r = await checkWebsite(p.website_url);
      logCheck(p.id, 'website', null, r);
    } catch (err) {
      console.error(`[${now()}] website check failed for project ${p.id}: ${err.message}`);
    }
  }
}

// Run twitter checks for all enabled projects
async function runTwitterTick() {
  const projects = db.prepare(`
    SELECT id, twitter_url FROM projects
    WHERE twitter_enabled = 1 AND twitter_url IS NOT NULL AND twitter_url != ''
  `).all();
  console.log(`[${now()}] Scheduler: twitter tick — ${projects.length} projects`);
  for (const p of projects) {
    try {
      const r = await checkTwitter(p.twitter_url);
      logCheck(p.id, 'twitter', null, r);
    } catch (err) {
      console.error(`[${now()}] twitter check failed for project ${p.id}: ${err.message}`);
    }
  }
}

// Run github commit checks for all enabled projects/repos
async function runCommitTick() {
  const projects = db.prepare(`SELECT id FROM projects WHERE github_enabled = 1`).all();
  console.log(`[${now()}] Scheduler: commit tick — ${projects.length} projects`);
  for (const p of projects) {
    const repos = db.prepare('SELECT full_name FROM repos WHERE project_id = ?').all(p.id);
    for (const repo of repos) {
      try {
        const r = await checkGithubRepo(repo.full_name, p.id);
        logCheck(p.id, 'github', repo.full_name, r);
      } catch (err) {
        console.error(`[${now()}] github check failed for ${repo.full_name}: ${err.message}`);
      }
    }
  }
}

// (Re)schedule jobs based on current config values.
// Reads config fresh on each call so changes via PUT take effect without restart.
function reschedule() {
  clearJobs();
  const cfg = db.prepare('SELECT * FROM config WHERE id = 1').get();
  if (!cfg) {
    console.warn(`[${now()}] Scheduler: no config row found, skipping schedule`);
    return;
  }

  const commitExpr = everyNHours(cfg.commit_check_hours);
  const websiteExpr = everyNHours(cfg.website_check_hours);
  const twitterExpr = everyNHours(cfg.twitter_check_hours);

  if (cron.validate(commitExpr)) {
    const j = cron.schedule(commitExpr, () => { runCommitTick().catch(err => console.error(err)); });
    jobs.push(j);
    console.log(`[${now()}] Scheduler: commit job → "${commitExpr}" (every ${cfg.commit_check_hours}h)`);
  }
  if (cron.validate(websiteExpr)) {
    const j = cron.schedule(websiteExpr, () => { runWebsiteTick().catch(err => console.error(err)); });
    jobs.push(j);
    console.log(`[${now()}] Scheduler: website job → "${websiteExpr}" (every ${cfg.website_check_hours}h)`);
  }
  if (cron.validate(twitterExpr)) {
    const j = cron.schedule(twitterExpr, () => { runTwitterTick().catch(err => console.error(err)); });
    jobs.push(j);
    console.log(`[${now()}] Scheduler: twitter job → "${twitterExpr}" (every ${cfg.twitter_check_hours}h)`);
  }
}

// Initialize scheduler; reschedule every 5 minutes to pick up config changes.
function init() {
  if (initialized) {
    reschedule();
    return;
  }
  initialized = true;
  reschedule();

  // Re-read config every 5 minutes
  setInterval(() => {
    reschedule();
  }, 5 * 60 * 1000);

  console.log(`[${now()}] Scheduler initialized`);
}

module.exports = {
  init,
  reschedule,
  runCommitTick,
  runWebsiteTick,
  runTwitterTick
};
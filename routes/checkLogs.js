// Check logs REST API
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// Expand JSON project cols to flat URL names for API compatibility.
function expandProjectUrls(row) {
  if (!row) return row;
  return {
    ...row,
    website_url:  row.website  ? JSON.parse(row.website).url  : null,
    github_url:   row.github   ? JSON.parse(row.github).url  : null,
    twitter_url:  row.twitter   ? JSON.parse(row.twitter).url : null,
  };
}

// ponytail: sort whitelists — accept only known column aliases, never raw user input
const CHECK_LOGS_SORT = { project_name: 'p.name', when: 'cl.checked_at' };
const STATUS_CHANGES_SORT = { project_name: 'p.name', when: 'rsc.created_at' };
const ALERT_LOGS_SORT = { project_name: 'p.name', when: 'al.created_at' };
function orderClause(map, sort, dir) {
  const col = map[sort] || map.when;
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${col} ${d}, id DESC`;
}

// GET /api/check-logs?project_id=X&resource_type=Y&search=TEXT&sort=COL&dir=DIR&limit=N&offset=M
router.get('/', async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
  const resourceType = req.query.resource_type || null;
  const search = req.query.search || null;
  const sort = req.query.sort || 'when';
  const dir = req.query.dir || 'desc';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = ['p.enabled = 1 AND p.user_id = ?'];
  const params = [req.userId];
  if (projectId) {
    conditions.push('cl.project_id = ?');
    params.push(projectId);
  }
  if (resourceType) {
    conditions.push('cl.resource_type = ?');
    params.push(resourceType);
  }
  if (search) {
    conditions.push("(p.name LIKE ? OR cl.resource_type LIKE ? OR cl.status LIKE ? OR cl.error_message LIKE ?)");
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = await db.prepare(`
    SELECT cl.*, p.name AS project_name,
      r.full_name,
      p.website, p.twitter, p.github
    FROM check_logs cl
    LEFT JOIN projects p ON p.id = cl.project_id
    LEFT JOIN repos r ON r.id = cl.resource_id AND cl.resource_type = 'github'
    ${where}
    ${orderClause(CHECK_LOGS_SORT, sort, dir)}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM check_logs cl LEFT JOIN projects p ON p.id = cl.project_id ${where}`).get(...params);
  res.json({ logs: rows.map(expandProjectUrls), total: totalRow.c, limit, offset });
});

// GET /api/check-logs/status-changes — event_logs entries
router.get('/status-changes', async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
  const resourceType = req.query.resource_type || null;
  const search = req.query.search || null;
  const sort = req.query.sort || 'when';
  const dir = req.query.dir || 'desc';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = ['p.enabled = 1 AND p.user_id = ?'];
  const params = [req.userId];
  if (projectId) {
    conditions.push('rsc.project_id = ?');
    params.push(projectId);
  }
  if (resourceType) {
    conditions.push('rsc.resource_type = ?');
    params.push(resourceType);
  }
  if (search) {
    conditions.push("(p.name LIKE ? OR rsc.resource_type LIKE ? OR rsc.event_type LIKE ? OR rsc.value LIKE ?)");
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = await db.prepare(`
    SELECT rsc.*, p.name AS project_name,
      p.website, p.twitter, p.github
    FROM event_logs rsc
    LEFT JOIN projects p ON p.id = rsc.project_id
    ${where}
    ${orderClause(STATUS_CHANGES_SORT, sort, dir)}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM event_logs rsc LEFT JOIN projects p ON p.id = rsc.project_id ${where}`).get(...params);
  res.json({ logs: rows.map(expandProjectUrls), total: totalRow.c, limit, offset });
});

// PATCH /api/check-logs/status-changes/:id/confirm  body: { confirmed: 0|1 }
router.patch('/status-changes/:id/confirm', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const confirmed = req.body?.confirmed ? 1 : 0;
  const row = await db.prepare(`
    SELECT rsc.id FROM event_logs rsc
    JOIN projects p ON p.id = rsc.project_id
    WHERE rsc.id = ? AND p.user_id = ?
  `).get(id, req.userId);
  if (!row) return res.status(404).json({ error: 'Status change not found' });
  await db.prepare('UPDATE event_logs SET confirmed = ? WHERE id = ?').run(confirmed, id);
  res.json({ ok: true, id, confirmed });
});

// POST /api/check-logs/status-changes/confirm-all — confirm all unconfirmed event logs for user
router.post('/status-changes/confirm-all', async (req, res) => {
  await db.prepare('UPDATE event_logs SET confirmed = 1 WHERE confirmed = 0 AND project_id IN (SELECT id FROM projects WHERE user_id = ?)').run(req.userId);
  res.json({ ok: true });
});

// GET /api/check-logs/alerts — alert_logs entries
router.get('/alerts', async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
  const resourceType = req.query.resource_type || null;
  const search = req.query.search || null;
  const sort = req.query.sort || 'when';
  const dir = req.query.dir || 'desc';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = ['p.enabled = 1 AND p.user_id = ?'];
  const params = [req.userId];
  if (projectId) {
    conditions.push('rsc.project_id = ?');
    params.push(projectId);
  }
  if (resourceType) {
    conditions.push('rsc.resource_type = ?');
    params.push(resourceType);
  }
  if (search) {
    conditions.push("(p.name LIKE ? OR rsc.resource_type LIKE ? OR rsc.event_type LIKE ? OR rsc.value LIKE ?)");
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const rows = await db.prepare(`
    SELECT al.*, p.name AS project_name, rsc.resource_type, rsc.event_type, rsc.value AS change_value,
      p.website, p.twitter, p.github
    FROM alert_logs al
    LEFT JOIN event_logs rsc ON rsc.id = al.status_change_id
    LEFT JOIN projects p ON p.id = rsc.project_id
    ${where}
    ${orderClause(ALERT_LOGS_SORT, sort, dir)}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM alert_logs al LEFT JOIN event_logs rsc ON rsc.id = al.status_change_id LEFT JOIN projects p ON p.id = rsc.project_id ${where}`).get(...params);
  res.json({ logs: rows.map(expandProjectUrls), total: totalRow.c, limit, offset });
});

module.exports = router;

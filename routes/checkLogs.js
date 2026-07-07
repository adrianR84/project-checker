// Check logs REST API
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// GET /api/check-logs?project_id=X&resource_type=Y&limit=N&offset=M
router.get('/', async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
  const resourceType = req.query.resource_type || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = [];
  const params = [];
  if (projectId) {
    conditions.push('project_id = ?');
    params.push(projectId);
  }
  if (resourceType) {
    conditions.push('resource_type = ?');
    params.push(resourceType);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.prepare(`
    SELECT cl.*, p.name AS project_name,
      r.full_name AS repo_name,
      p.website_url, p.twitter_url, p.github_url
    FROM check_logs cl
    LEFT JOIN projects p ON p.id = cl.project_id AND p.enabled = 1
    LEFT JOIN repos r ON r.id = cl.resource_id AND cl.resource_type = 'github'
    ${where}
    ORDER BY cl.checked_at DESC, cl.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM check_logs cl LEFT JOIN projects p ON p.id = cl.project_id AND p.enabled = 1 ${where}`).get(...params);
  res.json({ logs: rows, total: totalRow.c, limit, offset });
});

// GET /api/check-logs/status-changes — event_logs entries
router.get('/status-changes', async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
  const resourceType = req.query.resource_type || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = [];
  const params = [];
  if (projectId) {
    conditions.push('rsc.project_id = ?');
    params.push(projectId);
  }
  if (resourceType) {
    conditions.push('rsc.resource_type = ?');
    params.push(resourceType);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')} AND rsc.event_type != 'confirmed' AND p.enabled = 1` : "WHERE rsc.event_type != 'confirmed' AND p.enabled = 1";
  const rows = await db.prepare(`
    SELECT rsc.*, p.name AS project_name,
      p.website_url, p.twitter_url, p.github_url
    FROM event_logs rsc
    LEFT JOIN projects p ON p.id = rsc.project_id
    ${where}
    ORDER BY rsc.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')} AND rsc.event_type != 'confirmed' AND p.enabled = 1` : "WHERE rsc.event_type != 'confirmed' AND p.enabled = 1";
  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM event_logs rsc LEFT JOIN projects p ON p.id = rsc.project_id ${countWhere}`).get(...params);
  res.json({ logs: rows, total: totalRow.c, limit, offset });
});

// PATCH /api/check-logs/status-changes/:id/confirm  body: { confirmed: 0|1 }
router.patch('/status-changes/:id/confirm', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const confirmed = req.body?.confirmed ? 1 : 0;
  const row = await db.prepare('SELECT id FROM event_logs WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Status change not found' });
  await db.prepare('UPDATE event_logs SET confirmed = ? WHERE id = ?').run(confirmed, id);
  res.json({ ok: true, id, confirmed });
});

// GET /api/check-logs/alerts — alert_logs entries
router.get('/alerts', async (req, res) => {
  const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
  const resourceType = req.query.resource_type || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const conditions = [];
  const params = [];
  if (projectId) {
    conditions.push('rsc.project_id = ?');
    params.push(projectId);
  }
  if (resourceType) {
    conditions.push('rsc.resource_type = ?');
    params.push(resourceType);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')} AND p.enabled = 1` : 'WHERE p.enabled = 1';
  const rows = await db.prepare(`
    SELECT al.*, p.name AS project_name, rsc.resource_type, rsc.event_type, rsc.value AS change_value,
      p.website_url, p.twitter_url, p.github_url
    FROM alert_logs al
    LEFT JOIN event_logs rsc ON rsc.id = al.status_change_id
    LEFT JOIN projects p ON p.id = rsc.project_id
    ${where}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = await db.prepare(`SELECT COUNT(*) AS c FROM alert_logs al LEFT JOIN event_logs rsc ON rsc.id = al.status_change_id LEFT JOIN projects p ON p.id = rsc.project_id ${where}`).get(...params);
  res.json({ logs: rows, total: totalRow.c, limit, offset });
});

module.exports = router;

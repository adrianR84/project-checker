// Check logs REST API
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// GET /api/check-logs?project_id=X&resource_type=Y&limit=N&offset=M
router.get('/', (req, res) => {
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
  const rows = db.prepare(`
    SELECT cl.*, p.name AS project_name
    FROM check_logs cl
    LEFT JOIN projects p ON p.id = cl.project_id
    ${where}
    ORDER BY cl.checked_at DESC, cl.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM check_logs cl ${where}`).get(...params);
  res.json({ logs: rows, total: totalRow.c, limit, offset });
});

// GET /api/check-logs/status-changes — resource_status_changes entries
router.get('/status-changes', (req, res) => {
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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')} AND rsc.event_type = 'changed'` : "WHERE rsc.event_type = 'changed'";
  const rows = db.prepare(`
    SELECT rsc.*, p.name AS project_name
    FROM resource_status_changes rsc
    LEFT JOIN projects p ON p.id = rsc.project_id
    ${where}
    ORDER BY rsc.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const countWhere = conditions.length ? `WHERE ${conditions.join(' AND ')} AND rsc.event_type = 'changed'` : "WHERE rsc.event_type = 'changed'";
  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM resource_status_changes rsc ${countWhere}`).get(...params);
  res.json({ logs: rows, total: totalRow.c, limit, offset });
});

module.exports = router;
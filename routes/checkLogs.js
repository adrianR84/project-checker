// Check logs REST API
const express = require('express');
const db = require('../db');

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
    SELECT * FROM check_logs
    ${where}
    ORDER BY checked_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM check_logs ${where}`).get(...params);
  res.json({ logs: rows, total: totalRow.c, limit, offset });
});

module.exports = router;
// Token prices REST API
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// GET /api/token-prices — all token prices joined with project name
router.get('/', async (req, res) => {
  const rows = await db.prepare(`
    SELECT tp.*, p.name AS project_name
    FROM token_prices tp
    JOIN projects p ON p.id = tp.project_id
    ORDER BY p.name
  `).all();
  res.json(rows);
});

module.exports = router;

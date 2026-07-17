// Public API v1 — Bearer token auth (api_token in config.settings)
// Mounted BEFORE the session middleware so it handles its own auth.
const express = require('express');
const db = require('../services/db');

const router = express.Router();

// Authorize: extract and validate Bearer token, attach userId to req.
async function requireApiToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = auth.slice(7);
  if (!token) return res.status(401).json({ error: 'Missing token' });

  // Scan all config rows for a matching api_token
  const rows = await db.prepare('SELECT user_id, settings FROM config').all();
  const match = rows.find(r => {
    try { const s = JSON.parse(r.settings); return s.api_token === token; } catch { return false; }
  });
  if (!match) return res.status(401).json({ error: 'Invalid API token' });
  req.userId = match.user_id;
  next();
}

// POST /api/v1/projects/import — create project(s) from JSON body
// Accepts a single object:  { name, website, github, ... }
// Or an array of objects:   [{ name, ... }, { name, ... }]
router.post('/projects/import', requireApiToken, async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (!items.length) return res.status(400).json({ error: 'Request body is empty' });

  const results = [];
  const errors = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { name, website, github, twitter, telegram, symbol, contractAddress, chainId } = item || {};
    if (!name) { errors.push({ index: i, error: 'name is required' }); continue; }

    const ts = new Date().toISOString();
    const websiteJson  = website    ? JSON.stringify({ url: website, cc: 1 }) : null;
    const githubJson  = github     ? JSON.stringify({ url: github }) : null;
    const twitterJson = twitter    ? JSON.stringify({ url: twitter, pc: 1 }) : null;
    const telegramJson = telegram   ? JSON.stringify({ url: telegram }) : null;
    const tokenJson = (symbol || contractAddress || chainId)
      ? JSON.stringify({ symbol: symbol || '', contract: contractAddress || '', chain: chainId || 'solana' })
      : null;

    const existing = await db.prepare(
      'SELECT id FROM projects WHERE name = ? AND user_id = ?'
    ).get(name, req.userId);
    if (existing) { errors.push({ index: i, error: 'Project with this name already exists' }); continue; }

    try {
      const result = await db.prepare(`
        INSERT INTO projects (name, user_id, website, github, twitter, telegram,
          website_enabled, token, enabled, token_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, req.userId, websiteJson, githubJson, twitterJson, telegramJson,
        website ? 1 : 0, tokenJson, 1, tokenJson ? 1 : 0, ts, ts);

      results.push({ index: i, id: result.lastInsertRowid, name, created_at: ts });
    } catch (err) {
      errors.push({ index: i, error: err.message });
    }
  }

  res.status(results.length ? 201 : 400).json({ created: results, errors });
});

module.exports = router;

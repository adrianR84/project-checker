// Public API v1 — Bearer token auth (api_token in config.settings)
// Mounted BEFORE the session middleware so it handles its own auth.
const express = require('express');
const db = require('../services/db');

const router = express.Router();

/**
 * Express middleware: extract and validate Bearer token, attach userId to req.
 * Sets req.userId on success, sends 401 on failure.
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Express next
 */
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
    const tr = v => typeof v === 'string' ? v.trim() : v;
    const empty = v => !v || !tr(v);
    const val = v => tr(v) || null;

    if (empty(name)) { errors.push({ index: i, error: 'name is required' }); continue; }
    if (empty(symbol)) { errors.push({ index: i, error: 'symbol is required' }); continue; }
    if (empty(contractAddress)) { errors.push({ index: i, error: 'contractAddress is required' }); continue; }
    if (empty(chainId)) { errors.push({ index: i, error: 'chainId is required' }); continue; }

    const ts = new Date().toISOString();
    const websiteJson  = !empty(website)  ? JSON.stringify({ url: tr(website), cc: 1 }) : null;
    const githubJson   = !empty(github)   ? JSON.stringify({ url: tr(github) }) : null;
    const twitterJson  = !empty(twitter) ? JSON.stringify({ url: tr(twitter), pc: 1 }) : null;
    const telegramJson = !empty(telegram) ? JSON.stringify({ url: tr(telegram) }) : null;
    const tokenJson = JSON.stringify({ symbol: tr(symbol), contract: tr(contractAddress), chain: tr(chainId) });

    // Build a single "all provided fields match" check
    const conditions = ['user_id = ?'];
    const params = [req.userId];
    if (!empty(name))     { conditions.push('name = ?');           params.push(tr(name)); }
    if (!empty(website))  { conditions.push('website = ?');        params.push(websiteJson); }
    if (!empty(github))   { conditions.push('github = ?');         params.push(githubJson); }
    if (!empty(twitter))  { conditions.push('twitter = ?');        params.push(twitterJson); }
    if (!empty(telegram)) { conditions.push('telegram = ?');        params.push(telegramJson); }
    if (!empty(symbol))   { conditions.push('token = ?');           params.push(tokenJson); }
    const existing = await db.prepare(
      `SELECT id FROM projects WHERE ${conditions.join(' AND ')}`
    ).get(...params);
    if (existing) { errors.push({ index: i, error: 'Project with this combination of fields already exists' }); continue; }

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

// DELETE /api/v1/projects/remove — delete project by matching fields (same keys as import)
router.delete('/projects/remove', requireApiToken, async (req, res) => {
  const { name, website, github, twitter, telegram, symbol, contractAddress, chainId } = req.body || {};
  const tr = v => typeof v === 'string' ? v.trim() : v;
  const empty = v => !v || !tr(v);

  if (empty(symbol)) return res.status(400).json({ error: 'symbol is required' });
  if (empty(contractAddress)) return res.status(400).json({ error: 'contractAddress is required' });
  if (empty(chainId)) return res.status(400).json({ error: 'chainId is required' });

  const conditions = ['user_id = ?'];
  const params = [req.userId];
  if (!empty(symbol))
    { conditions.push('token = ?'); params.push(JSON.stringify({ symbol: tr(symbol), contract: tr(contractAddress), chain: tr(chainId) })); }

  const existing = await db.prepare(
    `SELECT id FROM projects WHERE ${conditions.join(' AND ')}`
  ).get(...params);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  await db.prepare('DELETE FROM projects WHERE id = ?').run(existing.id);
  res.json({ ok: true, deleted: existing.id });
});

module.exports = router;

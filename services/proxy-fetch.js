// services/proxy-fetch.js
// ponytail: Webshare rotating proxy pool. Round-robins across IP:PORT:USER:PASS entries via undici.ProxyAgent.
// Falls back to direct undici.fetch when disabled, pool unavailable, or a specific proxy fails.
const { fetch, ProxyAgent } = require('undici');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, '..', 'data', 'proxies.json');
const REFRESH_MS = 3_600_000; // 1 hour
let _pool = [];
let _lastFetchedAt = 0;
let _refreshing = null;
let _statsLoaded = false;
const proxyStats = new Map(); // host → {failures, successes}

// Load cached pool from disk (survives restarts, avoids unnecessary re-downloads)
function _loadCache() {
  try {
    if (!fs.existsSync(POOL_PATH)) return;
    const { pool, fetchedAt } = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
    if (!Array.isArray(pool) || !pool.length) return;
    _pool = pool;
    _lastFetchedAt = fetchedAt || 0;
    console.error(`[proxy-fetch] loaded ${pool.length} proxies from cache (stale for ${Math.round((Date.now() - _lastFetchedAt) / 1000 / 60)}m)`);
  } catch (e) {
    // cache read failure — proceed without cache
  }
}

function _saveCache() {
  try {
    fs.writeFileSync(POOL_PATH, JSON.stringify({ pool: _pool, fetchedAt: _lastFetchedAt }), 'utf8');
  } catch (e) {
    console.error(`[proxy-fetch] cache write failed: ${e.message}`);
  }
}

// ponytail: load cache synchronously at module load — before any requests are made
_loadCache();

async function _getDownloadToken(apiKey) {
  const res = await fetch('https://proxy.webshare.io/api/v2/download_token/proxy_list/', {
    headers: { Authorization: `Token ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Download token ${res.status}`);
  const data = await res.json();
  return data.key; // short-lived token, used in the download URL
}

async function _loadStats() {
  if (_statsLoaded) return;
  _statsLoaded = true;
  try {
    const rows = await db.config.getProxyStats();
    for (const r of rows) proxyStats.set(r.host, { failures: r.failures, successes: r.successes, totalMs: r.total_response_ms });
    console.error(`[proxy-fetch] loaded ${proxyStats.size} proxy stat rows`);
  } catch (e) {
    console.error(`[proxy-fetch] failed to load proxy stats: ${e.message}`);
  }
}

function _pickProxy() {
  _loadStats();
  // ponytail: pick the proxy with the lowest failure count, ties broken by avg response time
  const alive = _pool
    .map(p => {
      const stats = proxyStats.get(p.host) ?? { failures: 0, successes: 0, totalMs: 0 };
      return { proxy: p, failures: stats.failures, avgMs: stats.successes > 0 ? Math.round(stats.totalMs / stats.successes) : 0 };
    })
    .filter(p => p.failures < 3)
    .sort((a, b) => a.failures - b.failures || a.avgMs - b.avgMs);
  const list = alive.length ? alive.map(p => p.proxy) : _pool;
  // ponytail: round-robin across sorted pool
  const proxy = list[_proxyIdx++ % list.length];
  return proxy;
}

async function _downloadList(apiKey, country) {
  const cc = (country && country.trim()) ? country.trim() : '-';
  const downloadToken = await _getDownloadToken(apiKey);
  const url = `https://proxy.webshare.io/api/v2/proxy/list/download/${downloadToken}/${cc}/any/username/direct/-/`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Proxy list ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (!lines.length) throw new Error('Empty proxy list');
  return lines.map(l => {
    const [host, port, user, pass] = l.split(':');
    return { host: `${host}:${port}`, user, pass };
  });
}

async function _ensurePool() {
  const cfg = await db.config.getWebshare();
  if (!cfg?.enabled || !cfg?.token) return; // disabled
  const stale = !_pool.length || (Date.now() - _lastFetchedAt) > REFRESH_MS;
  if (!stale) return;
  if (_refreshing) return _refreshing;
  _refreshing = _downloadList(cfg.token, cfg.country)
    .then(pool => {
      _pool = pool;
      _lastFetchedAt = Date.now();
      _saveCache();
      console.error(`[proxy-fetch] loaded ${pool.length} proxies`);
    })
    .catch(err => {
      console.error(`[proxy-fetch] refresh failed: ${err.message}`);
    })
    .finally(() => {
      _refreshing = null;
    });
  return _refreshing;
}

/** Fetches url through a rotating Webshare proxy. Falls back to direct on pool failure or dead proxy. */
async function proxyFetch(url, opts = {}) {
  await _ensurePool();
  if (!_pool.length) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, opts);
      await db.config.upsertProxyStat({ host: 'direct', ok: true, responseMs: Date.now() - t0 }).catch(() => {});
      return res;
    } catch (e) {
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }
  const proxy = _pickProxy();
  const { host, user, pass } = proxy;
  const agent = new ProxyAgent({
    uri: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}`,
    connectTimeout: 10_000,
  });
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, dispatcher: agent });
    const prev = proxyStats.get(host) ?? { failures: 0, successes: 0, totalMs: 0 };
    proxyStats.set(host, { failures: prev.failures, successes: prev.successes + 1, totalMs: prev.totalMs + (Date.now() - t0) });
    await db.config.upsertProxyStat({ host, ok: true, responseMs: Date.now() - t0 }).catch(() => {});
    return res;
  } catch (proxyErr) {
    const prev = proxyStats.get(host) ?? { failures: 0, successes: 0, totalMs: 0 };
    proxyStats.set(host, { successes: prev.successes, failures: prev.failures + 1, totalMs: prev.totalMs });
    await db.config.upsertProxyStat({ host, ok: false, responseMs: 0 }).catch(() => {});
    console.warn(`[proxy-fetch] proxy failed (${host}), retrying direct: ${proxyErr.message}`);
    const t0d = Date.now();
    try {
      const res = await fetch(url, opts);
      await db.config.upsertProxyStat({ host: 'direct', ok: true, responseMs: Date.now() - t0d }).catch(() => {});
      return res;
    } catch (e) {
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }
}

module.exports = { proxyFetch };

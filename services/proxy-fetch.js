// services/proxy-fetch.js
// ponytail: Webshare rotating proxy pool. Round-robins across IP:PORT:USER:PASS entries via manual HTTP CONNECT tunnel (HTTP/1.1).
// Falls back to direct Node https when disabled, pool unavailable, or a specific proxy fails.
// ponytail: undici removed — Node 18+ native fetch is used instead
// const { fetch } = require('undici');
const { HttpsProxyAgent } = require('https-proxy-agent');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, '..', 'data', 'proxies.json');
const REFRESH_MS = 86_400_000; // 24 hours

const DECAY_MS = 21_600_000; // 6 hours
// ponytail: reduce failure counts by 25% every DECAY_MS so proxies slowly recover over time
const DECAY_PERSIST = 0; // 1 = write decayed failures back to proxy_stats DB (survives restarts), 0 = in-memory only

let _pool = [];
let _lastFetchedAt = 0;
let _refreshing = null;
let _statsLoaded = false;
let _proxyIdx = 0;
let _decayInterval = null;
const proxyStatsByIp = new Map(); // ip → {failures, successes}  — aggregated across ports

// ponytail: extract IP from "1.2.3.4:80" → "1.2.3.4"
function _ip(p) {
  return p.host.split(':')[0];
}

// Load cached pool from disk (survives restarts, avoids unnecessary re-downloads)
function _loadCache() {
  try {
    if (!fs.existsSync(POOL_PATH)) return;
    const { pool } = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
    if (!Array.isArray(pool) || !pool.length) return;
    _pool = pool;
    _lastFetchedAt = Date.now(); // reset so full REFRESH_MS applies from last restart
    //console.error(`[proxy-fetch] loaded ${pool.length} proxies from cache`);
  } catch (e) {
    // cache read failure — proceed without cache
  }
}

function _saveCache() {
  try {
    fs.writeFileSync(POOL_PATH, JSON.stringify({ pool: _pool, fetchedAt: _lastFetchedAt }), 'utf8');
  } catch (e) {
    //console.error(`[proxy-fetch] cache write failed: ${e.message}`);
  }
}

// ponytail: load cache synchronously at module load — before any requests are made
_loadCache();
_saveCache(); // persist with fresh timestamp on every startup

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
    for (const r of rows) {
      // ponytail: aggregate by IP across all ports
      const ip = r.host.split(':')[0];
      const agg = proxyStatsByIp.get(ip) ?? { failures: 0, successes: 0, totalMs: 0 };
      proxyStatsByIp.set(ip, {
        failures: agg.failures + r.failures,
        successes: agg.successes + r.successes,
        totalMs: agg.totalMs + r.total_response_ms,
      });
    }
    //console.error(`[proxy-fetch] loaded ${proxyStatsByIp.size} unique IPs from proxy stat rows`);
  } catch (e) {
    console.error(`[proxy-fetch] failed to load proxy stats: ${e.message}`);
  }
}

function _pickProxy() {
  _loadStats();
  // ponytail: weighted random — probability proportional to 1/(failures+1).
  // Lower failure count = higher weight. No hard exclusion; every proxy has a non-zero chance.
  const weighted = _pool.map(p => {
    const stats = proxyStatsByIp.get(_ip(p)) ?? { failures: 0, successes: 0, totalMs: 0 };
    return { proxy: p, weight: 1 / (stats.failures + 1) };
  });
  const total = weighted.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * total;
  for (const { proxy, weight } of weighted) {
    r -= weight;
    if (r <= 0) return proxy;
  }
  return weighted[weighted.length - 1].proxy; // fallback to last
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
      //console.error(`[proxy-fetch] loaded ${pool.length} proxies`);
    })
    .catch(err => {
      console.error(`[proxy-fetch] refresh failed: ${err.message}`);
    })
    .finally(() => {
      _refreshing = null;
    });
  return _refreshing;
}

// ponytail: reduce failure counts by 25% every DECAY_MS so proxies slowly recover over time
function _decayStats() {
  for (const [ip, stats] of proxyStatsByIp) {
    const decayed = Math.floor(stats.failures * 0.75);
    proxyStatsByIp.set(ip, { ...stats, failures: decayed });
    if (DECAY_PERSIST) {
      db.config.setProxyFailures(ip, decayed).catch(() => {});
    }
  }
}

/** Performs an HTTP/1.1 GET request through a CONNECT tunnel over a Webshare proxy. */
function _tunnelFetch(proxy, targetUrl, headers = {}, timeoutMs = 15000) {
  const u = new URL(targetUrl);
  const proxyUrl = `http://${proxy.user}:${proxy.pass}@${proxy.host}`;
  const agent = new HttpsProxyAgent(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = require('https').request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': headers['User-Agent'] ?? 'Mozilla/5.0', ...headers, 'Connection': 'close' },
      agent,
      timeout: timeoutMs,
    }, res => {
      let body = '';
      res.on('data', c => body += c.toString());
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', e => reject(e));
    req.end();
  });
}

/** Fetches url through a rotating Webshare proxy. Falls back to direct on pool failure or dead proxy. */
async function proxyFetch(url, opts = {}) {
  // ponytail: start failure-decay interval lazily on first use (only runs when webshare is enabled)
  if (!_decayInterval) {
    _decayInterval = setInterval(_decayStats, DECAY_MS);
  }
  await _ensurePool();
  const ua = opts?.headers?.['User-Agent'] ?? 'Mozilla/5.0';
  console.error(`[proxy-fetch] url=${url} poolLen=${_pool.length}`);

  if (!_pool.length) {
    const t0 = Date.now();
    try {
      console.error(`[proxy-fetch] direct fetch url=${url}`);
      const res = await fetch(url, {
        headers: { 'User-Agent': ua },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      console.error(`[proxy-fetch] direct fetch got res.status=${res.status}`);
      const body = await res.text();
      console.error(`[proxy-fetch] direct fetch ok res.status=${res.status} bodyLen=${body.length}`);
      await db.config.upsertProxyStat({ host: 'direct', ok: res.ok, responseMs: Date.now() - t0 }).catch(() => {});
      return { ok: res.ok, status: res.status, text: () => Promise.resolve(body) };
    } catch (e) {
      console.error(`[proxy-fetch] direct fetch failed: ${e.message}`);
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }
    } catch (e) {
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }

  const proxy = _pickProxy();
  const { host } = proxy;
  const ip = _ip(proxy);
  const t0 = Date.now();

  try {
    const { status, body } = await _tunnelFetch(proxy, url, { 'User-Agent': ua });
    console.error(`[proxy-fetch] tunnel ok status=${status} bodyLen=${body?.length}`);
    if (status >= 400) throw new Error(`HTTP ${status}`);
    // ponytail: record success — proxyStatsByIp already reflects correct state via _pickProxy
    const prev = proxyStatsByIp.get(ip) ?? { failures: 0, successes: 0, totalMs: 0 };
    proxyStatsByIp.set(ip, { failures: prev.failures, successes: prev.successes + 1, totalMs: prev.totalMs + (Date.now() - t0) });
    await db.config.upsertProxyStat({ host: ip, ok: true, responseMs: Date.now() - t0 }).catch(() => {});
    // ponytail: return a Response-like object so callers (.ok, .text()) work the same as undici fetch
    const ret = { ok: status < 400, status, text: () => Promise.resolve(body) };
    console.error(`[proxy-fetch] returning tunnel ret ok=${ret.ok} status=${ret.status}`);
    return ret;
  } catch (proxyErr) {
    // ponytail: proxy tunnel failed — record failure to proxy IP, then fall back to direct.
    // Failures decay over time via _decayStats, and _pickProxy uses weighted random,
    // so no hard exclusion — every proxy has a non-zero chance of being picked.
    console.warn(`[proxy-fetch] proxy failed (${host}), retrying direct: ${proxyErr.message}`);
    // ponytail: record proxy IP failure
    await db.config.upsertProxyStat({ host: ip, ok: false, responseMs: 0 }).catch(() => {});

    const t0d = Date.now();
    try {
      console.error(`[proxy-fetch] fallback direct fetch url=${url}`);
      const res = await fetch(url, {
        headers: { 'User-Agent': ua },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();
      console.error(`[proxy-fetch] fallback direct ok res.status=${res.status} bodyLen=${body.length}`);
      await db.config.upsertProxyStat({ host: 'direct', ok: res.ok, responseMs: Date.now() - t0d }).catch(() => {});
      return { ok: res.ok, status: res.status, text: () => Promise.resolve(body) };
    } catch (e) {
      console.error(`[proxy-fetch] fallback direct also failed: ${e.message}`);
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }
}

module.exports = { proxyFetch };

// services/proxy-fetch.js
// ponytail: Webshare rotating proxy pool. Round-robins across IP:PORT:USER:PASS entries via manual HTTP CONNECT tunnel (HTTP/1.1).
// Falls back to direct Node https when disabled, pool unavailable, or a specific proxy fails.
const https = require('https');
const net = require('net');
const tls = require('tls');
const db = require('./db');
const fs = require('fs');
const path = require('path');

const POOL_PATH = path.join(__dirname, '..', 'data', 'proxies.json');
const REFRESH_MS = 3_600_000; // 1 hour
let _pool = [];
let _lastFetchedAt = 0;
let _refreshing = null;
let _statsLoaded = false;
let _proxyIdx = 0;
const proxyStats = new Map(); // host → {failures, successes}

// Load cached pool from disk (survives restarts, avoids unnecessary re-downloads)
function _loadCache() {
  try {
    if (!fs.existsSync(POOL_PATH)) return;
    const { pool } = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
    if (!Array.isArray(pool) || !pool.length) return;
    _pool = pool;
    _lastFetchedAt = Date.now(); // reset so full REFRESH_MS applies from last restart
    console.error(`[proxy-fetch] loaded ${pool.length} proxies from cache`);
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
_saveCache(); // persist with fresh timestamp on every startup

function _httpsGet(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { headers: { ...headers, Host: u.host }, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET' };
    const req = https.request(opts, res => {
      if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function _getDownloadToken(apiKey) {
  const text = await _httpsGet('https://proxy.webshare.io/api/v2/download_token/proxy_list/', { Authorization: `Token ${apiKey}` }, 10_000);
  const data = JSON.parse(text);
  return data.key;
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
  const text = await _httpsGet(url, {}, 15_000);
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

/** Performs an HTTP/1.1 GET request through a CONNECT tunnel over a Webshare proxy. */
function _tunnelFetch(proxy, targetUrl, headers = {}, timeoutMs = 15000) {
  const u = new URL(targetUrl);
  const proxyHost = proxy.host.split(':')[0];
  const proxyPort = parseInt(proxy.host.split(':')[1]);
  const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');

  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, proxyHost);
    const cleanup = () => { try { sock.destroy(); } catch (_) {} };

    sock.on('connect', () => {
      sock.write(
        `CONNECT ${u.host} HTTP/1.1\r\n` +
        `Proxy-Authorization: Basic ${auth}\r\n` +
        `Host: ${u.host}\r\n\r\n`
      );
    });

    let headersDone = false;

    sock.on('data', d => {
      if (headersDone) return;
      const s = d.toString();
      if (!s.includes('\r\n\r\n')) return;
      headersDone = true;

      const status = s.match(/HTTP\/1\.\d (\d+)/)?.[1];
      if (status !== '200') { cleanup(); return reject(new Error('CONNECT ' + status)); }

      const tlsSocket = tls.connect({
        socket: sock,
        servername: u.hostname,
        rejectUnauthorized: false,
        // ponytail: TLSv1.2 only — TLSv1.3 causes EPROTO with some proxy servers
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      });

      tlsSocket.setTimeout(timeoutMs);
      tlsSocket.on('timeout', () => { cleanup(); reject(new Error('timeout')); });
      tlsSocket.on('error', e => { cleanup(); reject(e); });

      const req = `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n`;
      const extra = Object.entries(headers).map(([k, v]) => k + ': ' + v).join('\r\n');
      tlsSocket.write(req + (extra ? extra + '\r\n' : '') + 'Connection: close\r\n\r\n');

      let response = '';
      tlsSocket.on('data', c => response += c.toString());
      tlsSocket.on('end', () => {
        const hdrEnd = response.indexOf('\r\n\r\n');
        if (hdrEnd === -1) { reject(new Error('malformed response')); return; }
        const statusLine = response.slice(0, hdrEnd);
        const statusCode = parseInt(statusLine.match(/HTTP\/1\.\d (\d+)/)?.[1] ?? '0');
        resolve({ status: statusCode, body: response.slice(hdrEnd + 4) });
      });
    });

    sock.on('error', e => reject(e));
    sock.on('timeout', () => { cleanup(); reject(new Error('timeout')); });
    sock.setTimeout(timeoutMs + 2000, () => { cleanup(); reject(new Error('timeout')); });
  });
}

/** Fetches url through a rotating Webshare proxy. Falls back to direct on pool failure or dead proxy. */
async function proxyFetch(url, opts = {}) {
  await _ensurePool();
  const ua = opts?.headers?.['User-Agent'] ?? 'Mozilla/5.0';

  if (!_pool.length) {
    const t0 = Date.now();
    try {
      const u = new URL(url);
      const text = await new Promise((resolve, reject) => {
        require('https').get(u, { headers: { 'User-Agent': ua } }, res => {
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode ?? 0}`));
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(body));
        }).on('error', reject).setTimeout(15000, () => reject(new Error('timeout')));
      });
      await db.config.upsertProxyStat({ host: 'direct', ok: true, responseMs: Date.now() - t0 }).catch(() => {});
      return text;
    } catch (e) {
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }

  const proxy = _pickProxy();
  const { host } = proxy;
  const t0 = Date.now();

  try {
    const { status, body } = await _tunnelFetch(proxy, url, { 'User-Agent': ua });
    if (status >= 400) throw new Error(`HTTP ${status}`);
    const prev = proxyStats.get(host) ?? { failures: 0, successes: 0, totalMs: 0 };
    proxyStats.set(host, { failures: prev.failures, successes: prev.successes + 1, totalMs: prev.totalMs + (Date.now() - t0) });
    await db.config.upsertProxyStat({ host, ok: true, responseMs: Date.now() - t0 }).catch(() => {});
    return body;
  } catch (proxyErr) {
    const prev = proxyStats.get(host) ?? { failures: 0, successes: 0, totalMs: 0 };
    proxyStats.set(host, { successes: prev.successes, failures: prev.failures + 1, totalMs: prev.totalMs });
    await db.config.upsertProxyStat({ host, ok: false, responseMs: 0 }).catch(() => {});
    console.warn(`[proxy-fetch] proxy failed (${host}), retrying direct: ${proxyErr.message}`);

    const t0d = Date.now();
    try {
      const u = new URL(url);
      const text = await new Promise((resolve, reject) => {
        require('https').get(u, { headers: { 'User-Agent': ua } }, res => {
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode ?? 0}`));
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(body));
        }).on('error', reject).setTimeout(15000, () => reject(new Error('timeout')));
      });
      await db.config.upsertProxyStat({ host: 'direct', ok: true, responseMs: Date.now() - t0d }).catch(() => {});
      return text;
    } catch (e) {
      await db.config.upsertProxyStat({ host: 'direct', ok: false, responseMs: 0 }).catch(() => {});
      throw e;
    }
  }
}

module.exports = { proxyFetch };

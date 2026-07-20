// Notification dispatcher — sends Telegram and Pushbullet alerts when events are recorded.
// ponytail: single file, no retry queue, fire-and-forget.
const db = require('./db');

const now = () => new Date().toISOString();

// ─── Telegram ─────────────────────────────────────────────────────────────────

/** Sends a message via the Telegram Bot API. Returns {ok, error}. */
async function sendTelegramMessage(botToken, chatId, text, replyMarkup) {
  if (!botToken || !chatId) return { ok: false, error: 'missing bot_token or chat_id' };
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyMarkup && { reply_markup: replyMarkup }) })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      console.error(`[${now()}] Telegram send failed: ${data.description || r.status}`);
      return { ok: false, error: data.description || `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[${now()}] Telegram send error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── Pushbullet ───────────────────────────────────────────────────────────────

/** Pushes a note via the Pushbullet API. Returns {ok, error}. */
async function pushPushbulletNote(accessToken, title, body) {
  if (!accessToken) return { ok: false, error: 'missing access_token' };
  try {
    const r = await fetch('https://api.pushbullet.com/v2/pushes', {
      method: 'POST',
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: 'note', title, body })
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`[${now()}] Pushbullet push failed: HTTP ${r.status} ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[${now()}] Pushbullet push error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

/** Looks up the content of a twitter post for a new-post alert. */
async function getPostContent(projectId, postId) {
  if (!projectId || !postId) return null;
  try {
    const row = await db.prepare(
      'SELECT content, author, link FROM twitter_posts WHERE project_id = ? AND post_id = ? LIMIT 1'
    ).get(projectId, postId);
    return row || null;
  } catch { return null; }
}

/** Formats an event into a detail string (HTML, for Telegram). */
async function getDetail(event, v) {
  const { resource_type, event_type } = event;
  const rn = v.full_name || v.repo_name;
  if (event_type === 'changed' && resource_type === 'github') {
    return `new commit <code>${v.sha?.slice(0, 7) ?? '?'}</code> in <b>${rn ?? '?'}</b>`;
  }
  if (event_type === 'changed' && resource_type === 'website') {
    return `content changed\n<code>${v.bh?.slice(0, 8) ?? '?'}</code> → <code>${v.ah?.slice(0, 8) ?? '?'}</code>`;
  }
  if (event_type === 'tag_changed') {
    return `<b>${rn ?? '?'}</b> tag\n<code>${v.ot ?? 'none'}</code> → <code>${v.nt ?? '?'}</code>`;
  }
  if (event_type === 'deleted' && resource_type === 'github') {
    return `<b>${rn ?? '?'}</b> was deleted`;
  }
  if (event_type === 'changed' && resource_type === 'twitter' && v.new_posts !== undefined) {
    const post = await getPostContent(event.project_id, v.post_ids?.[0]);
    const link = post?.link ? `<a href="${post.link}">View post</a>\n` : '';
    const content = post?.content ? `${post.content.slice(0, 280)}` : '';
    return `new post${v.new_posts !== 1 ? 's' : ''}: <b>${v.new_posts}</b>\n${link}${content}`;
  }
  if (event_type === 'changed' && resource_type === 'twitter') {
    return `profile updated`;
  }
  return v && typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Plain-text alert string (for Pushbullet). */
async function formatAlert(event, projectName) {
  const { resource_type, event_type, value, created_at } = event;
  let detail = '';
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    const rn = v.full_name || v.repo_name;
    if (event_type === 'changed' && resource_type === 'github') {
      detail = `new commit ${v.sha?.slice(0, 7) ?? '?'} in ${rn ?? '?'}`;
    } else if (event_type === 'changed' && resource_type === 'website') {
      detail = `content changed: ${v.bh?.slice(0, 8) ?? '?'} -> ${v.ah?.slice(0, 8) ?? '?'}`;
    } else if (event_type === 'tag_changed') {
      detail = `${rn ?? '?'} tag: ${v.ot ?? 'none'} -> ${v.nt ?? '?'}`;
    } else if (event_type === 'deleted' && resource_type === 'github') {
      detail = `${rn ?? '?'} was deleted`;
    } else if (event_type === 'changed' && resource_type === 'twitter' && v.new_posts !== undefined) {
      const post = await getPostContent(event.project_id, v.post_ids?.[0]);
      const content = post?.content ? ` — "${post.content.slice(0, 280)}"` : '';
      detail = `new post${v.new_posts !== 1 ? 's' : ''}: ${v.new_posts}${content}`;
    } else if (event_type === 'changed' && resource_type === 'twitter') {
      detail = `profile updated`;
    } else {
      detail = value && typeof v === 'object' ? JSON.stringify(v) : String(value);
    }
  } catch {
    detail = String(value);
  }
  return `[${projectName ?? 'Project'}] ${resource_type} ${event_type}: ${detail} (${created_at})`;
}

/** HTML-formatted alert string for Telegram. */
async function formatAlertHtml(event, projectName) {
  const { resource_type, event_type, value, created_at } = event;
  const ts = created_at ? created_at.replace('T', ' ').slice(0, 16) : '?';
  let detail = '';
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    detail = await getDetail(event, v);
  } catch {
    detail = String(value);
  }
  return [
    `<b>🔔 ${projectName ?? 'Project'}</b>`,
    `<b>Type:</b> ${resource_type} / <i>${event_type}</i>`,
    detail,
    `<code>${ts}</code>`,
  ].join('\n');
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/** Sends an alert to all enabled channels. Never throws. */
async function sendAlert(event, projectName) {
  const [tgCfg, pbCfg] = await Promise.all([
    db.config.getTelegram(),
    db.config.getPushbullet()
  ]);
  const plain = await formatAlert(event, projectName);
  const html = await formatAlertHtml(event, projectName);

  if (tgCfg?.enabled && tgCfg.bot_token && tgCfg.chat_id) {
    const replyMarkup = {
      inline_keyboard: [[{ text: '✅ Confirm', callback_data: `confirm:${event.id}` }]]
    };
    const r = await sendTelegramMessage(tgCfg.bot_token, tgCfg.chat_id, html, replyMarkup);
    if (!r.ok) console.error(`[${now()}] Alert Telegram failed: ${r.error}`);
  }
  if (pbCfg?.enabled && pbCfg.access_token) {
    const r = await pushPushbulletNote(pbCfg.access_token, `Alert: ${event.event_type}`, plain);
    if (!r.ok) console.error(`[${now()}] Alert Pushbullet failed: ${r.error}`);
  }
}

// Maps threshold → tier index. Sorted descending: [largest]→STRONG, [middle]→MEDIUM, [smallest]→LIGHT.
function getTierIndex(priceChange, alerts) {
  const thresholds = [...new Set(alerts.map(a => a.price_change))].sort((a, b) => b - a);
  if (thresholds.length === 1) return 2; // single threshold → strong
  const idx = thresholds.indexOf(priceChange);
  return Math.max(0, thresholds.length - 1 - idx);
}

const INTENSITY = ['light', 'medium', 'strong'];
const ANCHOR = {
  'up-strong':   '🟢',
  'up-medium':   '🔵',
  'up-light':    '🟡',
  'down-strong': '🔴',
  'down-medium': '🟠',
  'down-light':  '🟡',
};

// Plain (Pushbullet)
function formatPriceAlert(projectName, price, priceChange, direction, tier) {
  const dirEmoji = direction === 'down' ? '🔻' : '🚀';
  const dirLabel  = direction === 'down' ? 'Dump' : 'Pump';
  const sign     = priceChange >= 0 ? '+' : '';
  return `${ANCHOR[direction + '-' + tier]} ${dirEmoji} ${projectName} [$${price}] [${dirLabel}-${tier}]: (${sign}${priceChange.toFixed(2)}%)`;
}

// HTML (Telegram) — chain and contract are optional; price becomes a DexScreener link when provided
function formatPriceAlertHtml(projectName, price, priceChange, direction, tier, chain, contract) {
  const dirEmoji = direction === 'down' ? '🔻' : '🚀';
  const dirLabel  = direction === 'down' ? 'Dump' : 'Pump';
  const sign     = priceChange >= 0 ? '+' : '';
  const priceStr = (chain && contract)
    ? `<a href="https://dexscreener.com/${chain}/${contract}">$${price}</a>`
    : `$${price}`;
  return `${ANCHOR[direction + '-' + tier]} ${dirEmoji} <b>${projectName}</b> [${priceStr}] [${dirLabel}-${tier}]: (<b>${sign}${priceChange.toFixed(2)}%</b>)`;
}

module.exports = {
  sendAlert, formatAlert, formatAlertHtml,
  sendTelegramMessage, pushPushbulletNote,
  formatPriceAlert, formatPriceAlertHtml, getTierIndex, INTENSITY
};

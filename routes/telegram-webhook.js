// Telegram webhook — receives callback_query button presses from the bot.
// No auth: Telegram bot API provides its own auth. chat_id validation prevents foreign-bot injection.
const db = require('../services/db');
const logger = require('../utils/logger');
const { parseDuration } = require('../services/notifications');

/**
 * Telegram webhook handler — receives callback_query button presses from the bot.
 * Validates chat_id to prevent foreign-bot injection, then marks events as confirmed.
 * @param {object} req - Express request (Telegram update payload)
 * @param {object} res - Express response
 */
module.exports = async function telegramWebhook(req, res) {
  const tgCfg = await db.config.getTelegram();

  const update = req.body;
  const cb = update?.callback_query;
  if (!cb) return res.status(200).end();

  async function ack(text) {
    if (!tgCfg?.bot_token || !cb.id) return;
    await fetch(`https://api.telegram.org/bot${tgCfg.bot_token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cb.id, text, show_alert: false })
    });
  }

  if (!tgCfg?.enabled || !tgCfg?.bot_token) { await ack('Bot disabled'); return res.status(200).end(); }

  const chatId = cb.message?.chat?.id;
  if (String(chatId) !== String(tgCfg.chat_id)) { await ack('Unauthorized chat'); return res.status(200).end(); }

  if (cb.data?.startsWith('confirm:')) {
    const [, id] = cb.data.split(':');
    if (!id) { await ack('Missing id'); return res.status(200).end(); }
    try {
      await db.prepare('UPDATE event_logs SET confirmed=1 WHERE id=?').run(id);
      await Promise.all([
        ack('✅ Confirmed'),
        fetch(`https://api.telegram.org/bot${tgCfg.bot_token}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        })
      ]);
    } catch (err) {
      await ack(`❌ Failed: ${err.message}`);
    }
  } else if (cb.data?.startsWith('snooze_price:')) {
    const parts = cb.data.split(':');
    const [, projectId, duration] = parts;
    if (!projectId || !duration) { await ack('Missing params'); return res.status(200).end(); }
    const ms = parseDuration(duration);
    if (!ms) { await ack('Invalid duration'); return res.status(200).end(); }
    try {
      const snoozedUntil = new Date(Date.now() + ms).toISOString();
      const existing = await db.prepare(
        'SELECT price_change FROM token_prices_alerts WHERE project_id = ?'
      ).all(Number(projectId));
      if (!existing.length) { await ack('No alert tiers to snooze'); return res.status(200).end(); }
      for (const row of existing) {
        await db.prepare(`
          INSERT INTO token_prices_alerts (project_id, price_change, created_at, snoozed_until)
          VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
          ON CONFLICT(project_id, price_change) DO UPDATE SET snoozed_until = excluded.snoozed_until
        `).run(Number(projectId), row.price_change, snoozedUntil);
      }
      await Promise.all([
        ack(`Snoozed for ${duration}`),
        fetch(`https://api.telegram.org/bot${tgCfg.bot_token}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            reply_markup: { inline_keyboard: [] }
          })
        })
      ]);
    } catch (err) {
      await ack(`❌ Failed: ${err.message}`);
    }
  } else {
    // ponytail: debug — show what we actually received
    await ack(`Unknown: ${cb.data}`);
  }

  res.status(200).json({ ok: true });
};

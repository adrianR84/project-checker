// Telegram webhook — receives callback_query button presses from the bot.
// No auth: Telegram bot API provides its own auth. chat_id validation prevents foreign-bot injection.
const db = require('../services/db');

module.exports = async function telegramWebhook(req, res) {
  const tgCfg = db.config.getTelegram();
  if (!tgCfg?.enabled || !tgCfg?.bot_token) return res.status(200).end();

  const update = req.body;
  if (!update?.callback_query) return res.status(200).end();

  const { callback_query } = update;
  const chatId = callback_query.message?.chat?.id;
  if (String(chatId) !== String(tgCfg.chat_id)) return res.status(200).end();

  if (callback_query.data?.startsWith('confirm:')) {
    const [, id] = callback_query.data.split(':');
    if (id) {
      await db.prepare('UPDATE event_logs SET confirmed=1 WHERE id=?').run(id);
      await fetch(`https://api.telegram.org/bot${tgCfg.bot_token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callback_query.id })
      });
    }
  }

  res.status(200).json({ ok: true });
};

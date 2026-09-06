/**
 * notify.mjs — one-way Telegram notification from the seller (optional).
 *
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID and seller-serve.mjs will post a line when an invoice is created
 * and when goods are delivered. Sending only; it never reads messages, so it can share a bot with OpenClaw
 * (OpenClaw keeps the long-poll; two pollers on one token would conflict, two senders do not).
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
export const enabled = Boolean(TOKEN && CHAT);
export async function notify(text) {
  if (!enabled) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}

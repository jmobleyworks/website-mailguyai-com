/**
 * MailguyAI — Sovereign Edge Email Gateway
 *
 * Competes directly with Postmark/Resend. Zero external API key dependency.
 * Email is dispatched via the native Cloudflare `send_email` Worker binding,
 * which routes through Cloudflare's own SMTP infrastructure.
 *
 * Bindings required:
 *   - SEND_EMAIL     : Cloudflare send_email binding (wrangler.toml [[send_email]])
 *   - MAILGUY_KV     : KV namespace for mail logs and static assets
 *   - MAILGUY_API_KEY: Secret — callers must Bearer-auth all /api/* requests
 *
 * API:
 *   GET  /                       Landing page (from KV static:index or fallback)
 *   GET  /api/v1/health          Health probe
 *   POST /api/v1/send            Send an email (authenticated)
 *   GET  /api/v1/mail/:id        Retrieve delivery log for a sent mail
 */

import { EmailMessage } from 'cloudflare:email';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(message, code = 'ERROR', status = 400) {
  return json({ error: message, code }, status);
}

/**
 * Build a RFC 2822-compliant MIME message string using only Web APIs.
 * No npm dependency required — Cloudflare Workers support TextEncoder natively.
 */
function buildMimeMessage({ from, fromName, to, subject, text, html }) {
  const boundary = `mailguy_${crypto.randomUUID().replace(/-/g, '')}`;
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  const date = new Date().toUTCString();

  let mime = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text || '',
    ``,
    `--${boundary}`,
  ].join('\r\n');

  if (html) {
    mime += [
      ``,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      html,
      ``,
    ].join('\r\n');
  }

  mime += `\r\n--${boundary}--\r\n`;
  return mime;
}

/**
 * Dispatch email via Cloudflare's native send_email binding.
 * This is the sovereign path — no Resend, no Postmark, no API keys.
 */
async function sendViaCloudflareSMTP(env, { from, fromName, to, subject, text, html }) {
  const mimeRaw = buildMimeMessage({ from, fromName, to, subject, text, html });
  const encoder = new TextEncoder();
  const message = new EmailMessage(from, to, encoder.encode(mimeRaw));
  await env.SEND_EMAIL.send(message);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // --- Landing page ---
    if (method === 'GET' && url.pathname === '/') {
      const html = await env.MAILGUY_KV.get('static:index') ||
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>MailguyAI — Sovereign Edge Email</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Georgia',serif;background:#0a0a0a;color:#e8e2d4;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .wrap{max-width:540px;text-align:center;padding:3rem 2rem}
  h1{font-size:2.4rem;font-weight:700;letter-spacing:-.02em;margin-bottom:.75rem}
  p{color:#888;line-height:1.7;margin-bottom:2rem}
  .badge{display:inline-block;padding:.35rem .85rem;border:1px solid #2a2a2a;border-radius:999px;font-size:.75rem;letter-spacing:.06em;color:#666;text-transform:uppercase}
</style></head>
<body><div class="wrap">
  <h1>MailguyAI</h1>
  <p>Sovereign edge email infrastructure. Zero third-party API dependency.<br>Built on Cloudflare's global SMTP backbone.</p>
  <span class="badge">Production · Edge-Native</span>
</div></body></html>`;
      return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // --- Health probe ---
    if (method === 'GET' && url.pathname === '/api/v1/health') {
      return json({ status: 'ok', version: '2.0.0', engine: 'cloudflare-native', timestamp: Date.now() });
    }

    // --- Auth gate for all /api/* routes ---
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== env.MAILGUY_API_KEY) {
      return err('Unauthorized', 'UNAUTHORIZED', 401);
    }

    // --- Send email ---
    if (method === 'POST' && url.pathname === '/api/v1/send') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON', 'INVALID_INPUT'); }

      const { to, subject, html, text, from_name, from } = body;
      if (!to || !subject || (!html && !text)) {
        return err('Missing required fields: to, subject, and html or text', 'INVALID_INPUT');
      }

      const fromAddr  = from || env.DEFAULT_FROM || `noreply@${env.FROM_DOMAIN || 'mailguyai.com'}`;
      const fromLabel = from_name || env.DEFAULT_FROM_NAME || 'MailguyAI';
      const mailId    = crypto.randomUUID();

      try {
        await sendViaCloudflareSMTP(env, {
          from: fromAddr,
          fromName: fromLabel,
          to,
          subject,
          text: text || '',
          html: html || '',
        });
      } catch (e) {
        console.error('[MailguyAI] Delivery failed:', e?.message || e);
        return err(`Delivery failed: ${e?.message || 'unknown'}`, 'SMTP_DELIVERY_FAILED', 502);
      }

      // Non-blocking KV log
      const logEntry = { id: mailId, status: 'sent', to, subject, sentAt: new Date().toISOString() };
      ctx.waitUntil(env.MAILGUY_KV.put(`mail:${mailId}`, JSON.stringify(logEntry), { expirationTtl: 86400 * 30 }));

      // Non-blocking billing event to VendyAI
      ctx.waitUntil(
        fetch('https://vendyai-com-worker.jmobleyworks.workers.dev/api/billing/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venture_id: 'mailguyai.com', user_id: to, event: 'email_sent', plan: 'sovereign' })
        }).catch(e => console.error('[MailguyAI] Billing event failed:', e))
      );

      return json({ success: true, id: mailId, engine: 'cloudflare-native' });
    }

    // --- Delivery log lookup ---
    if (method === 'GET' && url.pathname.startsWith('/api/v1/mail/')) {
      const mailId = url.pathname.split('/api/v1/mail/')[1];
      if (!mailId) return err('Mail ID required', 'INVALID_INPUT');
      const logStr = await env.MAILGUY_KV.get(`mail:${mailId}`);
      if (!logStr) return err('Not found', 'NOT_FOUND', 404);
      return json(JSON.parse(logStr));
    }

    return err('Not found', 'NOT_FOUND', 404);
  },
};

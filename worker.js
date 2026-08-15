export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const html = await env.MAILGUY_KV.get('static:index') || 
        '<!DOCTYPE html><html><body><h1>MailguyAI Edge Gateway Online</h1></body></html>';
      return new Response(html, { 
        headers: { ...corsHeaders, 'Content-Type': 'text/html' } 
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/health') {
      return new Response('OK', { status: 200, headers: corsHeaders });
    }

    if (request.method === 'POST' && url.pathname === '/api/v1/send') {
      // 1. Auth check
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || authHeader !== `Bearer ${env.MAILGUY_API_KEY}`) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // 2. Parse payload
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON payload' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { to, subject, html, text, from_name } = payload;

      // 3. Validate
      if (!to || !subject || (!html && !text)) {
        return new Response(JSON.stringify({ error: 'Missing required fields' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // 4. Send via Resend
      const fromEmail = from_name ? `${from_name} <noreply@mailguyai.com>` : 'noreply@mailguyai.com';
      
      const resendPayload = {
        from: fromEmail,
        to: [to],
        subject: subject,
        html: html,
        text: text
      };

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(resendPayload)
      });

      if (!resendRes.ok) {
        const errorText = await resendRes.text();
        return new Response(JSON.stringify({ error: 'Failed to send email', details: errorText }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const resendData = await resendRes.json();
      const mailId = resendData.id || crypto.randomUUID();

      // 5. Log to KV
      const timestamp = new Date().toISOString();
      const logEntry = {
        status: 'sent',
        timestamp,
        to,
        subject
      };
      
      ctx.waitUntil(env.MAILGUY_KV.put(`mail:${mailId}`, JSON.stringify(logEntry)));

      // 6. Fire non-blocking billing event
      const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('x-real-ip') || 'unknown';
      const billingEvent = {
        venture_id: 'mailguyai.com',
        user_id: clientIp,
        event: 'email_sent'
      };

      ctx.waitUntil(fetch('https://vendyai-com-worker.jmobleyworks.workers.dev/api/billing/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(billingEvent)
      }).catch(e => console.error('Billing event failed:', e)));

      return new Response(JSON.stringify({ success: true, id: mailId }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};

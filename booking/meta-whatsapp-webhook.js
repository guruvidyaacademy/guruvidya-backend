import { createHmac, timingSafeEqual } from 'node:crypto';

// This isolated endpoint is opt-in. It cannot replace BotSailor's webhook
// and must not be treated as proof of production event delivery.
export function installMetaWhatsAppWebhook(app) {
  const path = '/api/webhook/meta-whatsapp';
  app.get(path, (req, res) => {
    const token = String(process.env.GV_META_WEBHOOK_VERIFY_TOKEN || '');
    const mode = String(req.query['hub.mode'] || '');
    const provided = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    if (!token || mode !== 'subscribe' || !provided || !challenge ||
        !safeEqual(Buffer.from(provided), Buffer.from(token))) {
      return res.sendStatus(403);
    }
    return res.status(200).type('text/plain').send(challenge);
  });
  app.post(path, (req, res) => {
    const secret = String(process.env.GV_META_APP_SECRET || '');
    const signature = String(req.get('x-hub-signature-256') || '');
    const raw = req.metaWhatsAppRawBody;
    if (!secret || !raw || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return res.sendStatus(403);
    const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    if (!safeEqual(Buffer.from(signature.toLowerCase()), Buffer.from(expected))) return res.sendStatus(403);
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      return res.status(200).json({ received: true, ignored: true });
    }
    // Diagnostics only: no phone numbers, button payloads, customer text or secrets in logs.
    for (const entry of body.entry) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (change?.field !== 'messages') continue;
        for (const message of Array.isArray(change?.value?.messages) ? change.value.messages : []) {
          console.info('GV META WEBHOOK DIAGNOSTIC', {
            type: String(message?.type || '').slice(0, 40),
            hasButtonReply: Boolean(message?.interactive?.button_reply?.id || message?.button?.payload),
            hasContextMessageId: Boolean(message?.context?.id),
            hasInboundMessageId: Boolean(message?.id),
            actionTaken: false
          });
        }
      }
    }
    return res.status(200).json({ received: true });
  });
}
function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

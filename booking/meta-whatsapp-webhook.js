import { createHmac, timingSafeEqual } from 'node:crypto';

// Independent, signature-verified Meta webhook. Never replace BotSailor routing.
const normalize = value => String(value || '').trim().toLowerCase()
  .replace(/[‘’`´]/g, "'").replace(/\s+/g, ' ');
const buttonKeys = new Map([
  ["yes, i'll attend", 'yes_attend'], ["yes, i'll be there", 'yes_attend'],
  ['gv_smart_4h_yes_attend', 'yes_attend'],
  ['reschedule', 'reschedule'], ['appointment-reschedule', 'reschedule'],
  ['cancel appointment', 'cancel'], ['appointment-cancel', 'cancel'],
  ["yes, i'm on my way", 'on_my_way'], ['on my way', 'on_my_way'],
  ["yes, i'm ready", 'im_ready'], ["i'm ready", 'im_ready'],
  ['gv_smart_1h_on_my_way', 'on_my_way'], ['gv_smart_1h_im_ready', 'im_ready'],
  ['join online meeting', 'join_meeting'], ['booking_maps', 'join_meeting']
]);
const stageButtons = {
  '4h': new Set(['yes_attend','reschedule','cancel']),
  '2h': new Set(['yes_attend','reschedule','cancel']),
  '1h': new Set(['on_my_way','im_ready','reschedule','cancel']),
  '5min': new Set(['join_meeting','reschedule','cancel'])
};

export function metaButtonSelection(message) {
  const fields = message?.type === 'button'
    ? [message?.button?.payload, message?.button?.text]
    : message?.type === 'interactive' && message?.interactive?.type === 'button_reply'
      ? [message?.interactive?.button_reply?.id, message?.interactive?.button_reply?.title]
      : [];
  const mapped = [...new Set(fields.map(v => buttonKeys.get(normalize(v))).filter(Boolean))];
  return mapped.length === 1 ? mapped[0] : null;
}

async function auditManualButton(pool, message, onManualAction, onManualYes) {
  const context = String(message?.context?.id || '').trim();
  const eventId = String(message?.id || '').trim();
  const mobile = String(message?.from || '').replace(/\D/g, '');
  const button = metaButtonSelection(message);
  if (!context || !eventId || context === eventId || !/^\d{10,15}$/.test(mobile) || !button) {
    return { result: 'ignored_missing_or_unknown_fields' };
  }
  const mobile10 = mobile.slice(-10);
  // Exact outbound message + recipient match. Never attribute by time alone.
  const matches = await pool.query(`SELECT t.id,t.stage,t.booking_id,t.recipient_type,b.mode FROM booking_smart_reminder_manual_tests t
    JOIN student_bookings b ON b.id=t.booking_id
    WHERE t.channel='whatsapp' AND t.status='accepted'
      AND t.provider_message_id=$1 AND t.created_at>=NOW()-INTERVAL '15 days'
      AND regexp_replace(COALESCE(CASE WHEN t.recipient_type='parent'
        THEN b.parent_mobile ELSE b.student_mobile END,''),'[^0-9]','','g')
        IN ($2,$3)
    ORDER BY t.id DESC LIMIT 2`, [context,mobile10,'91'+mobile10]);
  if (matches.rowCount !== 1) return { result: 'no_unique_manual_test', count: matches.rowCount };
  const test = matches.rows[0];
  if (!stageButtons[test.stage]?.has(button)) return { result: 'button_not_valid_for_stage', stage: test.stage };
  if (test.stage === '1h' && ((test.mode === 'online' && button === 'on_my_way') ||
      (test.mode === 'offline' && button === 'im_ready'))) {
    return { result: 'button_not_valid_for_mode', stage: test.stage };
  }
  const saved = await pool.query(`INSERT INTO booking_smart_reminder_manual_clicks
    (manual_test_id,provider_event_id,button_key)
    VALUES($1,$2,$3)
    ON CONFLICT(manual_test_id,provider_event_id) DO NOTHING RETURNING id`,
    [test.id,eventId,button]);
  // Booking remains unchanged: a link is only a request to open the existing secure form.
  // Do not send the same action link twice for repeated Meta deliveries.
  let followup = 'not_applicable';
  if (saved.rowCount && button === 'yes_attend' && test.stage === '4h' && onManualYes) {
    try {
      const outcome = await onManualYes({ test, mobile, eventId });
      followup = outcome?.success ? 'sent' : (outcome?.status || 'send_failed');
    } catch (error) {
      followup = 'send_failed';
      console.error('GV META 4H YES FOLLOWUP ERROR', { manualTestId: test.id, error: error?.message || 'unknown' });
    }
  }
  if (saved.rowCount && ['reschedule','cancel'].includes(button) && onManualAction) {
    try {
      const outcome = await onManualAction({ test, button, mobile });
      followup = outcome?.success ? 'sent' : 'send_failed';
    } catch (error) {
      followup = 'send_failed';
      console.error('GV META MANUAL ACTION LINK ERROR', { manualTestId: test.id, button, error: error?.message || 'unknown' });
    }
  }
  return { result: saved.rowCount ? 'recorded' : 'duplicate', stage: test.stage, manualTestId: test.id, button, followup };
}

function metaPreferenceReply(message) {
  if (message?.type !== 'interactive' || message?.interactive?.type !== 'button_reply') return null;
  const reply = message.interactive.button_reply;
  const id = normalize(reply?.id);
  const title = normalize(reply?.title);
  const choices = new Map([
    ['gv_smart_2h_optin_yes','Yes'], ['gv_smart_2h_optin_no','No'],
    ['gv_pref_turn_on','Yes, Turn On'], ['gv_pref_turn_off','Yes, Turn Off'],
    ['gv_pref_keep_off','Keep Off'], ['gv_pref_keep_on','Keep On']
  ]);
  const expected = choices.get(id);
  return expected && normalize(expected) === title ? expected : null;
}
export function installMetaWhatsAppWebhook(app, { pool, onManualAction, onManualYes, onPreferenceReply } = {}) {
  const path = '/api/webhook/meta-whatsapp';
  app.get(path, (req, res) => {
    const token = String(process.env.GV_META_WEBHOOK_VERIFY_TOKEN || '');
    const mode = String(req.query['hub.mode'] || '');
    const provided = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    const tokenConfigured = Boolean(token);
    const modeValid = mode === 'subscribe';
    const tokenProvided = Boolean(provided);
    const challengeProvided = Boolean(challenge);
    const tokenMatches = tokenConfigured && tokenProvided &&
      safeEqual(Buffer.from(provided), Buffer.from(token));
    console.info('GV META WEBHOOK VERIFY', {
      tokenConfigured, modeValid, tokenProvided, challengeProvided, tokenMatches,
      accepted: tokenConfigured && modeValid && challengeProvided && tokenMatches
    });
    if (!tokenConfigured || !modeValid || !challengeProvided || !tokenMatches) return res.sendStatus(403);
    return res.status(200).type('text/plain').send(challenge);
  });
  app.post(path, async (req, res) => {
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
          if (!pool || !['button','interactive'].includes(message?.type)) continue;
          try {
            const preference = metaPreferenceReply(message);
            if (preference && onPreferenceReply) {
              const handled = await onPreferenceReply({ message, choice: preference });
              if (handled) {
                console.info('GV META 4H PREFERENCE REPLY', { handled: true });
                continue;
              }
            }
            const result = await auditManualButton(pool, message, onManualAction, onManualYes);
            console.info('GV META SMART MANUAL BUTTON', result);
          } catch (error) {
            console.error('GV META SMART MANUAL BUTTON ERROR', { error: error?.message || 'unknown' });
            // Return 500 so Meta may retry transient database failures; the unique
            // provider event ID prevents duplicate inserts on replay.
            return res.sendStatus(500);
          }
        }
      }
    }
    return res.status(200).json({ received: true });
  });
}
function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Step 34: deliberately UNMOUNTED adapter. No provider routes, jobs or sends.
import { createHmac, timingSafeEqual } from 'node:crypto';

const BUTTONS = new Set(['yes_attend','yes_be_there','on_my_way','ill_be_ready','reschedule','cancel','join_meeting']);
const MAX_EVENT_ID = 200;
export const CLICK_INGESTION_GATE = 'GV_SMART_REMINDER_CLICK_INGESTION';
export const RETENTION_GATE = 'GV_SMART_REMINDER_RETENTION_CLEANUP';

export function verifySignedRawPayload(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 65536 || typeof secret !== 'string' || secret.length < 32 || typeof signature !== 'string') return false;
  // Internal contract only; actual BotSailor webhook signature format must be verified before mounting.
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function validateClickEvent(event) {
  if (!event || !Number.isSafeInteger(event.deliveryId) || event.deliveryId < 1 || !BUTTONS.has(event.buttonKey) ||
      typeof event.providerEventId !== 'string' || event.providerEventId.length < 1 || event.providerEventId.length > MAX_EVENT_ID ||
      !/^[A-Za-z0-9_.:-]+$/.test(event.providerEventId)) throw new Error('Invalid click event');
  const date = new Date(event.clickedAt);
  if (typeof event.clickedAt !== 'string' || !Number.isFinite(date.getTime())) throw new Error('Invalid click timestamp');
  return Object.freeze({ deliveryId: event.deliveryId, buttonKey: event.buttonKey, providerEventId: event.providerEventId, clickedAt: date.toISOString() });
}

export async function ingestVerifiedClick({ pool, raw, signature, secret, event, schemaVerified = false, enabled = false }) {
  if (!enabled || process.env[CLICK_INGESTION_GATE] !== 'enabled') return { skipped: true, reason: 'ingestion_hold' };
  if (!schemaVerified) return { skipped: true, reason: 'migration_unverified' };
  if (!verifySignedRawPayload(raw, signature, secret)) return { skipped: true, reason: 'signature_invalid' };
  const click = validateClickEvent(event);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parent lock serializes aggregate updates, while dedupe prevents repeat events.
    const parent = await client.query(`SELECT id FROM booking_smart_reminder_deliveries WHERE id=$1 AND created_at >= NOW()-INTERVAL '15 days' FOR UPDATE`, [click.deliveryId]);
    if (!parent.rowCount) { await client.query('ROLLBACK'); return { skipped: true, reason: 'delivery_missing_or_expired' }; }
    const insert = await client.query(`INSERT INTO booking_smart_reminder_click_events(delivery_id,button_key,provider_event_id,clicked_at) VALUES($1,$2,$3,$4) ON CONFLICT (delivery_id,provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING RETURNING id`, [click.deliveryId,click.buttonKey,click.providerEventId,click.clickedAt]);
    if (insert.rowCount) {
      await client.query(`UPDATE booking_smart_reminder_deliveries SET first_clicked_at=LEAST(COALESCE(first_clicked_at,$2::timestamptz),$2::timestamptz),last_clicked_at=GREATEST(COALESCE(last_clicked_at,$2::timestamptz),$2::timestamptz),clicked_at=GREATEST(COALESCE(clicked_at,$2::timestamptz),$2::timestamptz),updated_at=NOW() WHERE id=$1`, [click.deliveryId,click.clickedAt]);
    }
    await client.query('COMMIT');
    return { inserted: insert.rowCount === 1, duplicate: insert.rowCount === 0 };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
}

// Review-only cleanup; explicitly disabled. No SQL even with injected pool.
export async function runDisabledRetentionCleanup() {
  return { skipped: true, reason: 'retention_hold', deleted: 0 };
}

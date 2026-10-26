// Smart Appointment Reminders — Step 2: deterministic, read-only scheduler planning.
// Intentionally UNMOUNTED. No database mutations, cron, queues or provider calls.
const STAGES = Object.freeze({offline:[['4h',240],['2h',120],['1h',60]],online:[['4h',240],['2h',120],['1h',60],['5min',5]]});
const ACTIVE = new Set(['requested','approved','confirmed','rescheduled']);
const CHANNELS = ['whatsapp','email'];
const RECIPIENTS = ['student','parent'];
const validDate = value => { const n = Date.parse(value); return Number.isFinite(n) ? n : NaN; };
export function planSmartReminderStages({booking, now=new Date(), masterEnabled=false, recipients=RECIPIENTS, channels=CHANNELS, stageEnabled=()=>true, expectedRevision, expectedStartsAt}={}) {
  const blocked = reason => Object.freeze({eligibleForDispatch:false,reason,items:[],claimed:0,sent:0});
  if (!masterEnabled) return blocked('master_off');
  if (!booking || booking.id == null || !ACTIVE.has(String(booking.status||'').toLowerCase()) || booking.cancelled_at || booking.trashed_at) return blocked('inactive_booking');
  const mode = String(booking.mode||'').toLowerCase();
  if (!STAGES[mode]) return blocked('invalid_mode');
  const startsAt = validDate(booking.starts_at);
  const expectedAt = validDate(expectedStartsAt);
  const clock = now instanceof Date ? now.getTime() : validDate(now);
  if (![startsAt,expectedAt,clock].every(Number.isFinite) || startsAt !== expectedAt || startsAt <= clock) return blocked('stale_appointment');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || booking.appointment_revision !== expectedRevision) return blocked('unverified_revision');
  if (!Array.isArray(recipients) || !Array.isArray(channels) || recipients.some(r=>!RECIPIENTS.includes(r)) || channels.some(c=>!CHANNELS.includes(c))) return blocked('invalid_recipient_or_channel');
  if (typeof stageEnabled !== 'function') return blocked('invalid_settings');
  const items=[];
  for (const [stage,minutes] of STAGES[mode]) {
    const dueAt=startsAt-minutes*60000;
    if (dueAt <= clock) continue; // never backfill expired stage; delivery is not active
    for (const recipient of new Set(recipients)) for (const channel of new Set(channels)) {
      if (!stageEnabled({mode,stage,recipient,channel})) continue;
      items.push(Object.freeze({bookingId:booking.id,appointmentRevision:expectedRevision,startsAt:new Date(startsAt).toISOString(),dueAt:new Date(dueAt).toISOString(),mode,stage,recipient,channel,idempotencyKey:[booking.id,expectedRevision,recipient,channel,stage].join(':')}));
    }
  }
  return Object.freeze({eligibleForDispatch:false,reason:'transport_hold',items:Object.freeze(items),claimed:0,sent:0});
}

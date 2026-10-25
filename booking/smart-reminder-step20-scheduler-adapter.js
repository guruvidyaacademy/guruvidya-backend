// Phase 3 Step 20: deliberately unmounted read-only scheduler adapter.
// No SQL, queue insertion, provider dispatch, or network access.
import { evaluateSmartReminderPreflight, SMART_REMINDER_DELIVERY_ENABLED } from './smart-reminder-step10-bridge.js';
export function planSmartReminderDisabled({ booking, expectedStartsAt, expectedRevision, recipient, channel }) {
  const check = evaluateSmartReminderPreflight({ booking, expectedStartsAt, expectedRevision, recipient, channel, masterEnabled: false });
  return Object.freeze({ eligibleForDispatch: false, claimed: 0, sent: 0, reason: check.reason, transportEnabled: SMART_REMINDER_DELIVERY_ENABLED });
}
export async function runSmartReminderDisabledScheduler() {
  return { skipped: true, reason: 'transport_hold', claimed: 0, sent: 0 };
}

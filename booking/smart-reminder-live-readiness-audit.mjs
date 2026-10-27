// Read-only deployment readiness audit. Does not alter database or send messages.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const base = dirname(fileURLToPath(import.meta.url));
const checks = [
  ['bridge', 'smart-reminder-step10-bridge.js', /SMART_REMINDER_DELIVERY_ENABLED\s*=\s*false|reason:\s*['"]transport_hold['"]/],
  ['scheduler', 'smart-reminder-step20-scheduler-adapter.js', /runSmartReminderDisabledScheduler|reason:\s*['"]transport_hold['"]/],
  ['handoff', 'smart-reminder-claim-delivery-handoff.js', /linked_transport_hold|No provider dispatch is possible/],
  ['atomic_queue', 'smart-reminder-step6h-atomic-queue.js', /Not wired to live dispatch|reserved_dispatch_not_connected/]
];
let blocked = false;
for (const [name, file, holdPattern] of checks) {
  const content = readFileSync(join(base, file), 'utf8');
  const held = holdPattern.test(content);
  console.log(`${name}: ${held ? 'BLOCKED - live integration not verified' : 'REVIEW REQUIRED - hold signature changed'}`);
  if (held) blocked = true;
}
console.log(blocked ? 'RESULT: NOT READY. Keep master automation OFF.' : 'RESULT: MANUAL INTEGRATION AND LIVE TESTS REQUIRED BEFORE ENABLING.');
process.exitCode = blocked ? 2 : 1;

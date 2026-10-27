GURUVIDYA SMART REMINDERS - STEP 6I: CLAIM RECOVERY SAFETY

Deploy: extract booking/ files to your existing backend booking/ directory.
DO NOT replace server.js. This is a changed-files-only ZIP.

What this adds:
- Read-only audit of stale claimed reminder jobs (30 min default).
- Explicit operator-controlled quarantine to skipped (NEVER auto-retry).
- No new database columns or migrations. Uses Step 1 queue table.
- Unit tests. Run: node --test booking/smart-reminder-step6i-claim-recovery.test.mjs

IMPORTANT:
- This is NOT imported by server.js and is NOT a running scheduler.
- Master Automation remains OFF. No WhatsApp or Email is sent.
- Never call quarantine on claims whose provider delivery status is uncertain.
- Do not auto-retry claimed jobs; provider may have accepted a message.
- Next live-dispatch integration needs booking revision, consent, provider acceptance, and delivery receipt checks.

GURUVIDYA SMART REMINDERS - STEP 6G DISPATCH GUARD

This patch adds an isolated, testable eligibility guard. It DOES NOT install or activate a live sender, claim jobs, or change server.js. Deploying it will not cause any WhatsApp or Email messages to send.

Copy both files to backend GitHub booking/ directory:
- booking/smart-reminder-step6g-dispatch-guard.js
- booking/smart-reminder-step6g-dispatch-guard.test.mjs

Run: node --test booking/smart-reminder-step6g-dispatch-guard.test.mjs

All 8 tests passed in preparation.

Master Automation must remain OFF. Live dispatch still needs verified atomic claiming, consent, provider transport integration, persisted receipts, and delivery tracking. No new environment variables.

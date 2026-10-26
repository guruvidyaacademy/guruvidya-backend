GURUVIDYA SMART REMINDERS — STEP 5 (SAFE DISPATCH BOUNDARY)

Copy booking/smart-reminder-step5-dispatch-boundary.js into the existing backend repository at the same path.
The .test.mjs file is optional for deployment; run it with Node 18+ using:
  node booking/smart-reminder-step5-dispatch-boundary.test.mjs

This step intentionally does NOT modify server.js, start a worker, enable Master Automation, or send any live WhatsApp/email messages.
It adds a gated, testable dispatch boundary for the later verified worker/provider integration.

DO NOT set masterEnabled/workerEnabled flags to true manually or bypass consent/template checks.
Before live sending, the deployed PostgreSQL migration and unique constraints must be independently verified, the booking revision and consent rechecked, and actual BotSailor/email provider adapters + callback tracking wired.

Deployment check: existing backend starts without errors; current booking notifications remain unchanged. Absence of a new startup log is expected (module not mounted).

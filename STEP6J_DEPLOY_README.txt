Guruvidya Smart Appointment Reminders — Step 6J (read-only readiness integration)

CHANGED FILES ONLY:
- server.js (existing full file; replace the matching backend server.js)
- booking/smart-reminder-step6j-worker-readiness.js (new)

Optional Render environment variable:
  GV_SMART_REMINDER_STEP6J_AUDIT=1
When set, startup and every 60 seconds log [Smart Reminders Step 6J] READINESS.
When unset, no database audit timer is started.

This step checks due pending jobs, stale pending jobs, claimed jobs, and stale claims.
It does NOT reserve jobs, send WhatsApp/email, update queue statuses, or enable automation.
No migration required. Existing booking notifications are not modified.
Keep Master Automation OFF until audited live transport integration is deployed and verified.

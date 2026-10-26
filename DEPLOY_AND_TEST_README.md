# Guruvidya — Manual real-message testing (guarded pilot)

This package is based on the uploaded 26 Oct 8:43 PM Admin and Backend archives. Only the listed source files change.

## Deployment
- Admin: replace `src/pages/SmartAppointmentReminders.jsx`.
- Backend: replace `booking/booking.js` and `server.js`.
- The outer ZIP contains separate `guruvidya-admin-main/` and `guruvidya-backend-main/` roots; **do not extract both into one project**.
- On Render, set `SMART_REMINDER_MANUAL_TEST_ENABLED=true` **only when supervised testing is intended**. Without it, the API returns 403 and no message sends.
- For WhatsApp, configure `SMART_REMINDER_TEST_TEMPLATE_OFFLINE_ID` and `SMART_REMINDER_TEST_TEMPLATE_ONLINE_ID` to the exact approved reminder-specific BotSailor template IDs, respectively. Existing provider credentials must be configured. **Templates with dynamic variable keys are deliberately blocked until mapping is reviewed**, so they will not send.
- For Email, existing configured Resend/SMTP failover transport is reused. The message is clearly marked TEST and includes no booking action links.
- Select a future approved/confirmed/rescheduled booking in Smart Appointment Reminders > Delivery & Tracking, expand it, choose recipient and stage, select Email/WhatsApp, click Send REAL Test, and confirm. The endpoint requires a valid admin booking session.

## Safety / current limitations
- Master Automation remains OFF; no automatic scheduler or scheduled sends are enabled.
- WhatsApp requires matching recipient verified opt-in; test-window overrides are ignored. Only approved reminder-specific templates with **no unverified dynamic variables** may send. This is intentionally conservative.
- Each booking/recipient/channel/stage has a 60-second manual-test cooldown. Unknown provider results are never auto-retried.
- Manual test attempts are saved separately in `booking_smart_reminder_manual_tests`, NOT as scheduled deliveries. They therefore do not appear in the existing production Delivery & Tracking channel timeline; the API GET `/api/admin/booking/smart-reminders/manual-tests` returns the last 30 attempts.
- `accepted` means provider API accepted a request, not delivered/read. Provider callbacks are not connected for manual tests.
- No live provider calls, production DB queries, Vercel build or Render deployment were performed during packaging. JavaScript syntax was checked locally; React/Vite production build was not verified.
- If a test reports a provider outcome as unknown, check provider logs before retrying. Do not repeatedly click.
- Stop manual testing by removing/unsetting `SMART_REMINDER_MANUAL_TEST_ENABLED` (or setting it to `false`).

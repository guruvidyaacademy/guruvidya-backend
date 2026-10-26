# Smart Appointment Reminders — Step 3 (HOLD)

Only three new `booking/` files. No existing source files modified. No Admin changes.

- `smart-reminder-step3-job-store.js`: validates Step 2 plans; review-only, explicitly gated persistence of future jobs with booking advisory lock, row lock, revision/start/status checks, and idempotent unique insertion. Defaults to HOLD. Does not send WhatsApp/email, claim due jobs or start a timer.
- `SMART_REMINDER_STEP3_SCHEMA_REVIEW.sql`: additive jobs table proposal. **Not applied or executed**. Before production use, review existing schema, revision updates and concurrency contract; apply through controlled migration only after approval.
- `SMART_REMINDER_STEP3_README.md`: this note.

Step 3 is a safe code foundation, **not an activated database-backed scheduler**. Master Automation stays OFF. The currently mounted disabled scheduler remains unchanged. No live database tests or deployment performed. A future separate review is required for migration, actual job polling, cancellation reconciliation, fallback and delivery.

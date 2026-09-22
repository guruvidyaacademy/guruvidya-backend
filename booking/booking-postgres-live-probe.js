// Build 71: explicitly opt-in, read-only PostgreSQL staging integration runner.
// Run from an authorized staging environment only; never sends messages or modifies data.
import { checkBookingPostgresStaging } from './booking-postgres-staging-check.js';
import { inspectBookingDatabase } from './booking-database-integration.js';

export async function runBookingPostgresProbe({ pool, schema = 'public', stagingConfirmed = false } = {}) {
  if (stagingConfirmed !== true) throw Error('staging_confirmation_required');
  if (!pool || typeof pool.connect !== 'function') throw Error('invalid_staging_pool');
  const schemaCheck = await checkBookingPostgresStaging(pool, { schema });
  // The existing inspection uses current_schema(); do not silently inspect a different schema.
  if (schema !== 'public') return Object.freeze({ schemaReady: schemaCheck.schemaReady,
    missingColumns: schemaCheck.missingColumns, inspectionSkipped: true,
    reason: 'inspection_requires_default_schema', dispatchAuthorized: false, liveVerified: false });
  if (!schemaCheck.schemaReady) return Object.freeze({ schemaReady: false,
    missingColumns: schemaCheck.missingColumns, inspectionSkipped: true,
    dispatchAuthorized: false, liveVerified: false });
  const inspection = await inspectBookingDatabase(pool);
  return Object.freeze({ schemaReady: inspection.schemaReady,
    missingColumns: inspection.missingColumns, bookings: inspection.bookings,
    outbox: inspection.outbox, validConsentCount: inspection.validConsentCount,
    inspectionSkipped: false, dispatchAuthorized: false, liveVerified: false });
}

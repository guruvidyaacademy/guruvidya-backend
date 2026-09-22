// Build 76: opt-in, read-only staging integration runner. No dispatch, writes or secrets in report.
import { checkBookingPostgresStaging } from './booking-postgres-staging-check.js';
import { createBookingBotSailorStagingProbe } from './booking-botsailor-staging-probe.js';

export async function runBookingStagingIntegration({ environment, stagingConfirmed, dispatchEnabled, pool, schema = 'public', botSailorEndpoint, botSailorApiToken, fetchImpl, timeoutMs } = {}) {
  if (environment !== 'staging' || stagingConfirmed !== true || dispatchEnabled !== false)
    throw new Error('Staging read-only verification prerequisites not satisfied');
  if (!pool || typeof pool.connect !== 'function') throw new Error('Invalid staging database pool');
  // Validate provider configuration before opening any database connection.
  const probe = createBookingBotSailorStagingProbe({endpoint: botSailorEndpoint, apiToken: botSailorApiToken, fetchImpl, timeoutMs});
  // Database driver errors may contain connection strings or SQL parameters.
  // Fail closed without forwarding those details to an admin-facing caller.
  let database;
  try {
    database = await checkBookingPostgresStaging(pool, {schema});
  } catch {
    throw new Error('Staging database inspection failed; dispatch remains disabled');
  }
  // Treat malformed adapter reports as failures, not permission to contact a provider.
  if (!database || typeof database.schemaReady !== 'boolean' || !Array.isArray(database.missingColumns) ||
      database.missingColumns.some(value => typeof value !== 'string' || !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(value)) ||
      new Set(database.missingColumns).size !== database.missingColumns.length || database.readOnly !== true ||
      database.dispatchAuthorized !== false || database.liveVerified !== false ||
      (database.schemaReady && database.missingColumns.length !== 0) ||
      (!database.schemaReady && database.missingColumns.length === 0))
    throw new Error('Invalid staging database inspection result; dispatch remains disabled');
  // Do not contact provider when schema is missing; no automatic remediation or dispatch.
  if (!database.schemaReady) return Object.freeze({databaseSchemaReady: false, missingColumns: Object.freeze([...database.missingColumns]),
    botSailorReachable: null, botSailorAuthenticated: null, readyForManualReview: false, readOnly: true, liveVerified: false, dispatchAuthorized: false});
  const provider = await probe();
  return Object.freeze({databaseSchemaReady: true, missingColumns: Object.freeze([]),
    botSailorReachable: provider.reachable, botSailorAuthenticated: provider.authenticated,
    readyForManualReview: provider.reachable && provider.authenticated, readOnly: true,
    liveVerified: false, dispatchAuthorized: false});
}

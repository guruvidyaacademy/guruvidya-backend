// Build 57: offline, fail-closed assessment of externally collected staging evidence.
// This module neither performs staging tests nor authorizes production dispatch.
const REQUIRED = Object.freeze([
  'database_migration_and_rollback',
  'booking_create_cancel_reschedule',
  'slot_concurrency_and_idempotency',
  'admin_authentication_and_role_permissions',
  'student_parent_consent_and_revocation',
  'botsailor_template_and_dynamic_url',
  'callback_authentication_and_replay',
  'delivery_persistence_and_retry',
  'privacy_and_secret_redaction',
  'staging_backup_and_restore'
]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
export const requiredBookingStagingChecks = REQUIRED;
export function assessBookingStagingSecurity(evidence) {
  if (!plain(evidence)) throw Error('invalid_staging_evidence');
  const keys = Object.keys(evidence);
  if (keys.some(key => !REQUIRED.includes(key))) throw Error('unknown_staging_check');
  const checks = REQUIRED.map(name => {
    const item = Object.hasOwn(evidence, name) ? evidence[name] : null;
    if (item === null) return Object.freeze({name, status:'missing'});
    if (!plain(item) || !Object.hasOwn(item, 'passed') || !Object.hasOwn(item, 'evidenceId') || typeof item.passed !== 'boolean' || typeof item.evidenceId !== 'string' || !ID.test(item.evidenceId) || Object.keys(item).some(key => !['passed','evidenceId'].includes(key))) throw Error('invalid_staging_check');
    return Object.freeze({name, status:item.passed ? 'reported_pass' : 'reported_fail'});
  });
  const complete = checks.every(check => check.status === 'reported_pass');
  // Even all reported passes cannot prove live execution or permit production rollout.
  return Object.freeze({checks:Object.freeze(checks), reportedComplete:complete, productionAuthorized:false, liveVerified:false});
}

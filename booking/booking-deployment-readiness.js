// Build 49: conservative, offline deployment gate. This module never changes live configuration.
const REQUIRED_CHECKS=Object.freeze([
 'database_migrations_applied','database_backup_restore_tested','authenticated_admin_routes_tested',
 'admin_role_permissions_tested','student_parent_consent_tested','consent_revocation_tested',
 'approved_template_staging_tested','provider_callback_signature_tested',
 'notification_idempotency_tested','notification_retry_tested',
 'booking_create_cancel_reschedule_tested','privacy_and_log_redaction_tested',
 'rollback_procedure_tested','live_staging_end_to_end_tested'
]);
export function assessBookingDeploymentReadiness({preflight,checks={},dispatchEnabled=false}={}) {
 const pending=[];
 if(!preflight||typeof preflight!=='object'||preflight.databaseSchemaReady!==true||preflight.providerConfigReady!==true) pending.push('integration_preflight_not_passed');
 if(!checks||typeof checks!=='object'||Array.isArray(checks)) checks={};
 for(const name of REQUIRED_CHECKS) if(checks[name]!==true) pending.push(name);
 if(dispatchEnabled!==false) pending.push('dispatch_must_remain_disabled_before_approval');
 // Offline attestations cannot establish live production readiness.
 return Object.freeze({offlineChecksComplete:pending.length===0,productionReady:false,dispatchEnabled:false,liveIntegrationVerified:false,pending:Object.freeze(pending)});
}
export {REQUIRED_CHECKS};

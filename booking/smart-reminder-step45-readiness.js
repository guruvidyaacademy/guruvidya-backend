// Step 45: pure offline readiness gate. UNMOUNTED. No IO, SQL, scheduler, or sends.
const REQUIRED = Object.freeze([
  'admin_build_verified','backend_dependencies_verified','postgres_schema_verified',
  'postgres_concurrency_verified','provider_authentication_verified',
  'provider_account_namespace_verified','webhook_event_mapping_verified',
  'recipient_address_policy_verified','revision_lifecycle_verified',
  'retention_fk_verified','end_to_end_staging_verified',
  'operator_release_approval'
]);
export function reviewReleaseReadiness(evidence={}) {
  const blockers=REQUIRED.filter(key=>evidence?.[key]!==true);
  // This is an audit report only; it never authorizes dispatch or migration.
  return Object.freeze({productionReady:false,activationAllowed:false,
    blockers:Object.freeze(blockers),sent:0,deleted:0,reason:'manual_release_hold'});
}
export function disabledReleaseActivation(){return {productionReady:false,activationAllowed:false,sent:0,deleted:0,reason:'manual_release_hold'};}

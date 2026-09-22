// Build 64: read-only consolidation of independent offline readiness assessments.
// This cannot verify live integrations, change dispatch settings, or authorize rollout.
import {assessBookingStagingSecurity} from './booking-staging-security-gate.js';
import {assessBookingDeploymentReadiness} from './booking-deployment-readiness.js';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export function reviewBookingRollout({stagingEvidence, preflight, deploymentChecks, dispatchEnabled=false}={}) {
  if (!plain(stagingEvidence)) throw Error('invalid_staging_evidence');
  if (deploymentChecks !== undefined && !plain(deploymentChecks)) throw Error('invalid_deployment_checks');
  if (typeof dispatchEnabled !== 'boolean') throw Error('invalid_dispatch_setting');
  const staging=assessBookingStagingSecurity(stagingEvidence);
  const deployment=assessBookingDeploymentReadiness({preflight,checks:deploymentChecks,dispatchEnabled});
  const blockers=[];
  if (!staging.reportedComplete) blockers.push('staging_evidence_incomplete');
  if (!deployment.offlineChecksComplete) blockers.push('deployment_evidence_incomplete');
  if (dispatchEnabled) blockers.push('dispatch_must_remain_disabled');
  blockers.push('live_postgresql_botsailor_consent_and_booking_tests_not_verified');
  return Object.freeze({staging,deployment,blockers:Object.freeze(blockers),productionReady:false,liveVerified:false,dispatchAuthorized:false});
}

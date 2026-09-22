// Build 50: offline rollout planning only. This module cannot enable delivery.
import {assessBookingDeploymentReadiness, REQUIRED_CHECKS} from './booking-deployment-readiness.js';

const STAGES=Object.freeze(['offline_review','staging_verification','controlled_pilot','production_rollout']);
const EVIDENCE_FIELDS=Object.freeze(['reference','verifiedBy','verifiedAt']);
function validEvidence(record) {
 if (!record || typeof record!=='object' || Array.isArray(record)) return false;
 if (EVIDENCE_FIELDS.some(k=>typeof record[k]!=='string'||!record[k].trim())) return false;
 const time=Date.parse(record.verifiedAt);
 return Number.isFinite(time) && new Date(time).toISOString()===record.verifiedAt && time<=Date.now();
}
export function planBookingRollout({preflight,checks={},evidence={},dispatchEnabled=false}={}) {
 const readiness=assessBookingDeploymentReadiness({preflight,checks,dispatchEnabled});
 const missingEvidence=REQUIRED_CHECKS.filter(key=>checks?.[key]===true&&!validEvidence(evidence?.[key]));
 const pending=Object.freeze([...readiness.pending,...missingEvidence.map(key=>`evidence_missing:${key}`)]);
 return Object.freeze({stage:STAGES[0],nextStage:STAGES[1],stages:STAGES,
  offlineReviewComplete:readiness.offlineChecksComplete&&missingEvidence.length===0,
  productionReady:false,dispatchEnabled:false,liveIntegrationVerified:false,
  pending,manualActions:Object.freeze([
   'Verify PostgreSQL schema and backup restore in staging',
   'Verify BotSailor approved template, callback authentication, and real delivery statuses in staging',
   'Test consent opt-in/revocation and admin permissions against actual routes',
   'Test create, reschedule, cancel, retries, idempotency, and rollback end-to-end',
   'Obtain explicit operator approval before any controlled pilot; keep Picktime active until independently verified'
  ])});
}

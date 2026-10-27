import test from 'node:test';
import assert from 'node:assert/strict';
import {auditSmartReminderClaims,quarantineSmartReminderClaims} from './smart-reminder-step6i-claim-recovery.js';
test('audit is read only and returns stale claims',async()=>{
 const calls=[];const pool={query:async(...args)=>{calls.push(args);return {rows:[{id:1}]}}};
 const result=await auditSmartReminderClaims(pool,{now:'2026-10-27T08:00:00Z'});
 assert.equal(result.count,1);assert.equal(result.recoveryEnabled,false);
 assert.match(calls[0][0],/^SELECT/);assert.equal(calls[0][1][0],'2026-10-27T07:30:00.000Z');
});
test('quarantine blocked by default',async()=>{
 const result=await quarantineSmartReminderClaims({query:()=>{throw Error('must not query')}},{ids:[1]});
 assert.equal(result.changed,0);
});
test('explicit quarantine only touches claimed ids',async()=>{
 const pool={query:async(sql,params)=>{assert.match(sql,/status='claimed'/);assert.deepEqual(params,[[1,2]]);return {rows:[{id:1}]}}};
 const result=await quarantineSmartReminderClaims(pool,{ids:[1,2],confirmedNoSendInFlight:true});
 assert.deepEqual(result.quarantinedIds,[1]);
});

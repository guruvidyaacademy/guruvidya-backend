import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveDueSmartReminderJobs } from './smart-reminder-step6h-atomic-queue.js';
test('safe default never accesses DB', async () => {
 const result = await reserveDueSmartReminderJobs(null);
 assert.deepEqual(result, {claimed:[],reason:'disabled'});
});
test('validates limit', async () => {
 await assert.rejects(() => reserveDueSmartReminderJobs({connect(){throw Error('should not connect')}}, {enabled:true,limit:0}), /invalid_limit/);
});
test('atomic reservation commits and releases', async () => {
 const queries=[];let released=false;
 const client={query:async (sql)=>{queries.push(sql);return {rows:[{id:1}]};},release(){released=true;}};
 const result=await reserveDueSmartReminderJobs({connect:async()=>client},{enabled:true});
 assert.equal(result.claimed.length,1);assert.equal(queries[0],'BEGIN');
 assert.match(queries[1],/SKIP LOCKED/);assert.equal(queries[2],'COMMIT');assert.equal(released,true);
});
test('rolls back on database failure', async () => {
 const queries=[];let released=false;
 const client={query:async (sql)=>{queries.push(sql);if(sql.includes('WITH selected')) throw Error('db_failed');return {};},release(){released=true;}};
 await assert.rejects(()=>reserveDueSmartReminderJobs({connect:async()=>client},{enabled:true}),/db_failed/);
 assert.equal(queries.at(-1),'ROLLBACK');assert.equal(released,true);
});

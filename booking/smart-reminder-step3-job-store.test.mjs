import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePlannedJob,persistPlannedSmartReminderJobs} from './smart-reminder-step3-job-store.js';
const startsAt='2026-10-28T10:00:00.000Z';
const job={bookingId:12,appointmentRevision:1,recipient:'student',channel:'email',stage:'4h',mode:'offline',startsAt,dueAt:'2026-10-28T09:53:00.000Z',stageMinutes:7,idempotencyKey:'12:1:student:email:4h'};
test('accepts dynamically configured stage minutes',()=>assert.equal(validatePlannedJob(job),true));
test('rejects inconsistent due time',()=>assert.throws(()=>validatePlannedJob({...job,stageMinutes:8}),/invalid_job_dates/));
test('does not access DB until prerequisites verified',async()=>assert.deepEqual(await persistPlannedSmartReminderJobs(null,[job]),{persisted:0,skipped:0,sent:0,reason:'scheduler_not_connected'}));
test('transactional idempotent insert, no dispatch',async()=>{
  const calls=[];let released=false;
  const client={query:async(sql)=>{calls.push(sql);if(sql.includes('FROM student_bookings'))return {rows:[{id:12,appointment_revision:1,starts_at:startsAt,status:'confirmed',mode:'offline',trashed_at:null,cancelled_at:null}]};if(sql.includes('INSERT INTO'))return {rowCount:1};return {rows:[]};},release:()=>{released=true;}};
  const result=await persistPlannedSmartReminderJobs({connect:async()=>client},[job],{schemaVerified:true,revisionWritesVerified:true,allowPersistence:true,now:'2026-10-28T09:00:00.000Z'});
  assert.equal(result.persisted,1);assert.equal(result.sent,0);assert.equal(released,true);assert.ok(calls.includes('COMMIT'));
});

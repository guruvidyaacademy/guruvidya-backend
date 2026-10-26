import test from 'node:test';
import assert from 'node:assert/strict';
import { planSmartReminderStages, resolveSmartReminderStageMinutes } from './smart-reminder-stage-planner.js';
const settings={stage_minutes:{offline:{'4h':465,'2h':90,'1h':20},online:{'4h':240,'2h':120,'1h':60,'5min':10}}};
test('custom stage offsets',()=>{
 const starts_at='2026-11-01T12:00:00.000Z';
 const result=planSmartReminderStages({booking:{id:1,status:'confirmed',mode:'offline',starts_at,appointment_revision:1},expectedStartsAt:starts_at,expectedRevision:1,now:'2026-10-31T00:00:00.000Z',masterEnabled:true,settings,recipients:['student'],channels:['email']});
 assert.equal(result.items.length,3);
 assert.equal(result.items[0].dueAt,'2026-11-01T04:15:00.000Z');
 assert.equal(result.items[2].stageMinutes,20);
 assert.equal(result.eligibleForDispatch,false);
});
test('duplicate timings rejected',()=> assert.throws(()=>resolveSmartReminderStageMinutes({stage_minutes:{offline:{'4h':60,'2h':60}}})));
test('master OFF produces no jobs',()=> assert.equal(planSmartReminderStages({masterEnabled:false}).items.length,0));

import test from 'node:test';
import assert from 'node:assert/strict';
import {runSmartReminderStep6Preflight} from './smart-reminder-step6-preflight.js';
const cols={booking_smart_reminder_jobs:'id booking_id appointment_revision recipient channel stage mode starts_at due_at status created_at updated_at',student_bookings:'id appointment_revision starts_at status mode trashed_at cancelled_at student_mobile parent_mobile student_email parent_email',booking_settings:'id settings'};
const fake=(unique=true,drop='')=>({query:async(sql)=>sql.includes('information_schema.columns')?{rows:Object.entries(cols).flatMap(([table_name,v])=>v.split(' ').filter(x=>x!==drop).map(column_name=>({table_name,column_name})))}:{rows:[{ok:unique}]}});
test('complete schema passes but does not enable dispatch',async()=>{const r=await runSmartReminderStep6Preflight(fake());assert.equal(r.ready,true);assert.equal(r.dispatchEnabled,false)});
test('missing revision blocks readiness',async()=>{const r=await runSmartReminderStep6Preflight(fake(true,'appointment_revision'));assert.equal(r.ready,false)});
test('missing unique constraint blocks readiness',async()=>{const r=await runSmartReminderStep6Preflight(fake(false));assert.equal(r.ready,false)});

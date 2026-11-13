import test from 'node:test';
import assert from 'node:assert/strict';
import { planOneHourFollowup } from './smart-reminder-1h-followup-timing.js';
test('offline default 10m email fallback then +5m follow-up', () => {
 const p=planOneHourFollowup({startsAt:'2026-11-16T09:00:00+05:30',mode:'offline'});
 assert.equal(p.primaryButton,'On My Way');
 assert.equal(p.whatsappAt,'2026-11-16T02:30:00.000Z');
 assert.equal(p.emailFallbackAt,'2026-11-16T02:40:00.000Z');
 assert.equal(p.needToChangeAt,'2026-11-16T02:45:00.000Z');
});
test('admin fallback 20m moves follow-up accordingly', () => {
 const p=planOneHourFollowup({startsAt:'2026-11-16T09:00:00+05:30',mode:'online',settings:{fallback_minutes:{'1h':20}}});
 assert.equal(p.primaryButton,"I'm Ready");
 assert.equal(p.emailFallbackAt,'2026-11-16T02:50:00.000Z');
 assert.equal(p.needToChangeAt,'2026-11-16T02:55:00.000Z');
});
test('invalid settings fail closed',()=>assert.throws(()=>planOneHourFollowup({startsAt:'2026-11-16T09:00:00+05:30',mode:'offline',settings:{fallback_minutes:{'1h':-1}}}),/invalid_fallback_minutes/));

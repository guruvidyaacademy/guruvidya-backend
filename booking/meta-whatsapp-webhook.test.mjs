import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metaButtonSelection } from './meta-whatsapp-webhook.js';
test('Meta template button payload resolves', () => {
  assert.equal(metaButtonSelection({type:'button',button:{payload:"Yes, I'll Attend",text:"Yes, I'll Attend"}}),'yes_attend');
  assert.equal(metaButtonSelection({type:'button',button:{payload:'Reschedule',text:'Reschedule'}}),'reschedule');
  assert.equal(metaButtonSelection({type:'button',button:{payload:'Cancel Appointment',text:'Cancel Appointment'}}),'cancel');
});
test('Meta interactive reply resolves and conflicts are rejected', () => {
  assert.equal(metaButtonSelection({type:'interactive',interactive:{type:'button_reply',button_reply:{id:'gv_smart_1h_on_my_way',title:"Yes, I'm On My Way"}}}),'on_my_way');
  assert.equal(metaButtonSelection({type:'button',button:{payload:'Reschedule',text:'Cancel Appointment'}}),null);
  assert.equal(metaButtonSelection({type:'text',text:{body:'Reschedule'}}),null);
  assert.equal(metaButtonSelection({type:'button',button:{payload:'unknown'}}),null);
});

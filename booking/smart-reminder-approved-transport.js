// Smart Appointment Reminders only. Adapter around existing, injected CRM senders.
// No provider credentials, routes or existing booking notification flows are modified.
// Caller must verify booking revision, consent, template approval and durable unique claim.
import { dispatchSmartReminderJob } from './smart-reminder-step5-dispatch-boundary.js';

const allowed = new Set(['4h','2h','1h','5min']);
export function createSmartReminderApprovedTransport({sendWhatsAppTemplate, sendEmail, resolveApprovedTemplate} = {}) {
  return async function deliver(job, verified = {}) {
    const sendApprovedMessage = async (item) => {
      if (!allowed.has(item.stage)) throw Error('invalid_reminder_stage');
      const template = await resolveApprovedTemplate?.(item);
      if (!template || template.approved !== true || !template.id || template.channel !== item.channel ||
          template.stage !== item.stage || template.mode !== item.mode) throw Error('approved_reminder_template_missing');
      const sender = item.channel === 'whatsapp' ? sendWhatsAppTemplate : sendEmail;
      if (typeof sender !== 'function') throw Error('reminder_sender_unavailable');
      // Do not reuse appointment-confirmation templates for reminder stages.
      // Do not retry unknown outcomes: provider may have accepted the message.
      const receipt = await sender({job:item, template});
      const providerMessageId = receipt?.providerMessageId || receipt?.wa_message_id || receipt?.message_id || receipt?.response?.message_id;
      return receipt?.success === true && providerMessageId ? {providerMessageId:String(providerMessageId)} : null;
    };
    return dispatchSmartReminderJob(job, {...verified, sendApprovedMessage});
  };
}

// Build 43: offline approval manifest for the private booking-link template.
// This does not assume BotSailor's API payload shape and cannot send messages.
const ID=/^[A-Za-z0-9_-]{1,100}$/;
const SHA256=/^[a-f0-9]{64}$/i;
export function validateBookingTemplateMapping(mapping, expectedTemplateId) {
  const reasons=[];
  if (!mapping || typeof mapping!=='object' || Array.isArray(mapping)) return {valid:false,reasons:['mapping_missing']};
  if (!ID.test(String(expectedTemplateId||'')) || mapping.templateId!==expectedTemplateId) reasons.push('template_id_mismatch');
  if (mapping.provider!=='botsailor') reasons.push('provider_mismatch');
  if (mapping.approved!==true) reasons.push('template_not_approved');
  if (mapping.buttonType!=='dynamic_url') reasons.push('dynamic_url_button_required');
  if (!Number.isSafeInteger(mapping.buttonIndex)||mapping.buttonIndex<0||mapping.buttonIndex>9) reasons.push('invalid_button_index');
  if (mapping.variableMode!=='full_url' && mapping.variableMode!=='url_suffix') reasons.push('unverified_variable_mode');
  if (!SHA256.test(String(mapping.approvedTemplateSha256||''))) reasons.push('approved_template_fingerprint_missing');
  if (mapping.stagingVerified!==true) reasons.push('staging_verification_missing');
  return {valid:reasons.length===0,reasons};
}
export function requireBookingTemplateMapping(mapping,expectedTemplateId) {
  const result=validateBookingTemplateMapping(mapping,expectedTemplateId);
  if (!result.valid) throw Error('Booking template mapping blocked: '+result.reasons.join(','));
  return Object.freeze({templateId:mapping.templateId,provider:mapping.provider,buttonType:mapping.buttonType,buttonIndex:mapping.buttonIndex,variableMode:mapping.variableMode,approvedTemplateSha256:mapping.approvedTemplateSha256.toLowerCase()});
}

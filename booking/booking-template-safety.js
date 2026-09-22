// Conservative guard for the Build 18 static-template sender. Imported metadata is
// not a substitute for checking the approved template in Meta/BotSailor.
export function staticReminderTemplateCheck(template, attestedId) {
  const reasons=[];
  if (!template || !template.botsailor_id || template.botsailor_id !== attestedId)
    reasons.push('template_id_not_attested');
  if (!['approved','active'].includes(String(template?.status||'').toLowerCase()))
    reasons.push('template_not_approved');
  const body=String(template?.body_content||'');
  if (!body.trim()) reasons.push('template_body_missing');
  if (/\{\{[^}]+\}\}|\{[^{}]*\b(?:name|date|time|link|url|phone|course)\b[^{}]*\}/i.test(body))
    reasons.push('template_body_has_variables');
  // An imported template can contain buttons/header variables not visible in body_content.
  // Require a deliberate, template-ID-specific staging attestation after manual review.
  if (!attestedId) reasons.push('static_template_attestation_missing');
  return {safe:reasons.length===0,reasons};
}

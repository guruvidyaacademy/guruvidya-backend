// Build 45: fail-closed, offline authorization and notification-control gate.
// Invoke on the authenticated server before any booking notification operation.
// This module does not create endpoints, persist settings, or send messages.
const ROLES = Object.freeze({
  super_admin: new Set(['read','configure','preview','dispatch']),
  manager_admin: new Set(['read','preview']),
  sales_admin: new Set(['read']),
  reception_admin: new Set(['read'])
});
const ACTIONS = new Set(['read','configure','preview','dispatch']);
const OWN = Object.prototype.hasOwnProperty;
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
export function bookingNotificationPermission(actor, action) {
  if (!ACTIONS.has(action)) return Object.freeze({allowed:false,reason:'unknown_action'});
  if (!isPlain(actor) || actor.authenticated !== true || typeof actor.role !== 'string' || !OWN.call(ROLES,actor.role))
    return Object.freeze({allowed:false,reason:'unauthorized'});
  return Object.freeze({allowed:ROLES[actor.role].has(action),reason:ROLES[actor.role].has(action)?'allowed':'forbidden'});
}
export function validateBookingNotificationControls(controls) {
  if (!isPlain(controls)) throw Error('invalid_notification_controls');
  // Require explicit booleans: absent, strings, and truthy values fail closed.
  for (const key of ['notificationsEnabled','whatsappEnabled','dispatchEnabled','maintenanceMode'])
    if (!OWN.call(controls,key) || typeof controls[key] !== 'boolean') throw Error('invalid_notification_controls');
  return Object.freeze({notificationsEnabled:controls.notificationsEnabled,whatsappEnabled:controls.whatsappEnabled,
    dispatchEnabled:controls.dispatchEnabled,maintenanceMode:controls.maintenanceMode});
}
export function requireBookingNotificationOperation({actor,action,controls}={}) {
  const permission=bookingNotificationPermission(actor,action);
  if (!permission.allowed) throw Error('booking_notification_'+permission.reason);
  const settings=validateBookingNotificationControls(controls);
  if (action==='dispatch' && (!settings.notificationsEnabled || !settings.whatsappEnabled || !settings.dispatchEnabled || settings.maintenanceMode))
    throw Error('booking_notification_dispatch_disabled');
  return Object.freeze({action,allowed:true});
}

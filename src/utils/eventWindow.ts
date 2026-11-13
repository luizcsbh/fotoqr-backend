/**
 * Entry window of an event at the gate. Invitations follow the event's CURRENT dates, so changing
 * the event dates applies to every invitation already issued, and an invitation is never "born"
 * expired because it copied an end time that later moved.
 */

/** Hours after the event end during which invitations are still accepted (late arrivals). */
export const CHECKIN_GRACE_HOURS = (() => {
  const parsed = Number(process.env.CHECKIN_GRACE_HOURS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 6;
})();

interface EventDates {
  endAt?: Date | string | null;
  endDate?: Date | string | null;
}

/** End of the event, or null when it has none (then invitations never expire by date). */
export function getEventEnd(event: EventDates): Date | null {
  const raw = event.endAt || event.endDate;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Last moment an invitation of this event is accepted at the gate (event end + grace period). */
export function getCheckinDeadline(event: EventDates): Date | null {
  const end = getEventEnd(event);
  return end ? new Date(end.getTime() + CHECKIN_GRACE_HOURS * 60 * 60 * 1000) : null;
}

/** True when the event (including the grace period) is already over. */
export function isEventOver(event: EventDates, now = new Date()): boolean {
  const deadline = getCheckinDeadline(event);
  return deadline !== null && deadline < now;
}

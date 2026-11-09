// One clock for the whole server, so tests can move time forward to check waves, reminders and quiet hours.
let offsetMs = 0;

export const nowMs = () => Date.now() + offsetMs;
export const nowIso = () => new Date(nowMs()).toISOString();
export const isoIn = (ms) => new Date(nowMs() + ms).toISOString();
export const MIN = 60000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// Only reachable through the test hooks (TEST_HOOKS=1).
export function setClock({ set, advanceMs } = {}) {
  if (set) offsetMs = Date.parse(set) - Date.now();
  if (advanceMs) offsetMs += advanceMs;
  return nowIso();
}

// Pakistan has one time zone (UTC+5) and no daylight saving.
export const PKT_OFFSET = 5 * HOUR;
export const pktHour = (ms = nowMs()) => new Date(ms + PKT_OFFSET).getUTCHours();
export const pktDate = (ms = nowMs()) => new Date(ms + PKT_OFFSET).toISOString().slice(0, 10);
// The next moment the Pakistan clock shows `hour`:00, strictly after `ms`.
export function nextPktHour(hour, ms = nowMs()) {
  const local = new Date(ms + PKT_OFFSET);
  local.setUTCHours(hour, 0, 0, 0);
  let t = local.getTime() - PKT_OFFSET;
  if (t <= ms) t += DAY;
  return t;
}

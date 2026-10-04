/**
 * P8.4 — ticket-leak evidence for V-ticket (design §19). rtc-node sends its
 * token in a header, so an `access_token=` query line from a generator IP in
 * nginx's access log means a ticket reached a log. Only THIS run's lines count:
 * a generator address can carry history (the first real run counted a day-old
 * JS-SDK line from the same host). Pure; the caller reads the files.
 */

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const TIME = /\[(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\]/;

/** The `[03/Oct/2026:20:47:05 +0200]` time of an nginx log line, in epoch ms, or null. */
export function parseNginxTime(line: string): number | null {
  const m = TIME.exec(line);
  if (m === null) return null;
  const [, day, mon, year, hh, mm, ss, sign, oh, om] = m;
  const month = MONTHS[mon ?? ''];
  if (month === undefined) return null;
  const utc = Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss));
  const offsetMs = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === '-' ? -1 : 1);
  return utc - offsetMs;
}

/**
 * `access_token=` lines from `ips` (the line's first field) logged at or after
 * `sinceMs`. A matching line whose time cannot be read is counted: an
 * unreadable timestamp never hides a leak.
 */
export function countTicketLines(text: string, ips: readonly string[], sinceMs: number): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('access_token=') || !ips.includes(line.split(' ')[0] ?? '')) continue;
    const at = parseNginxTime(line);
    if (at === null || at >= sinceMs) count += 1;
  }
  return count;
}

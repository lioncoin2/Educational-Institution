import { countTicketLines, parseNginxTime } from '../observe/access-log';

const GEN = '203.0.113.7';
const line = (ip: string, time: string, path: string): string =>
  `${ip} - - [${time}] "GET ${path} HTTP/1.1" 101 1954 "-" "-"`;
const TOKEN = '/rtc?access_token=REDACTED&auto_subscribe=1';
const RUN_START = Date.UTC(2026, 9, 4, 18, 49, 0); // 2026-10-04 20:49:00 +0200

describe('observe/access-log — V-ticket evidence', () => {
  it('parses the nginx time with its offset to epoch ms', () => {
    expect(parseNginxTime(line(GEN, '04/Oct/2026:20:49:00 +0200', '/'))).toBe(RUN_START);
    expect(parseNginxTime(line(GEN, '04/Oct/2026:13:49:00 -0500', '/'))).toBe(RUN_START);
    expect(parseNginxTime('no time here')).toBeNull();
    expect(parseNginxTime(line(GEN, '04/Foo/2026:20:49:00 +0200', '/'))).toBeNull();
  });

  it('regression: a generator IP line from BEFORE the run is history, not a leak', () => {
    // First real run: a day-old JS-SDK line from the same address made V-ticket fail.
    const text = [
      line(GEN, '03/Oct/2026:20:47:05 +0200', TOKEN),
      line(GEN, '04/Oct/2026:20:49:30 +0200', '/rtc?auto_subscribe=1'),
    ].join('\n');
    expect(countTicketLines(text, [GEN], RUN_START)).toBe(0);
  });

  it('counts a ticket line from a generator IP at or after the run start', () => {
    const text = [
      line(GEN, '04/Oct/2026:20:49:00 +0200', TOKEN),
      line(GEN, '04/Oct/2026:20:55:00 +0200', TOKEN),
      line('198.51.100.9', '04/Oct/2026:20:50:00 +0200', TOKEN), // not a generator
    ].join('\n');
    expect(countTicketLines(text, [GEN], RUN_START)).toBe(2);
  });

  it('a ticket line whose time cannot be read still counts (never hides a leak)', () => {
    expect(countTicketLines(`${GEN} - - [garbled] "GET ${TOKEN} HTTP/1.1"`, [GEN], RUN_START)).toBe(
      1,
    );
  });

  it('matches the IP as the whole first field, not a prefix', () => {
    const text = line('203.0.113.70', '04/Oct/2026:20:50:00 +0200', TOKEN);
    expect(countTicketLines(text, [GEN], RUN_START)).toBe(0);
  });
});

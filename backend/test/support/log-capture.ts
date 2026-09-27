import type { LoggerService } from '@nestjs/common';

import { FAKE_TOKEN_PATTERN } from '../../src/modules/live/infrastructure/fake-rtc-provider';

/** One line the application logged: its level, and its arguments as `serialize` writes them. */
export interface CapturedLine {
  readonly level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
  readonly json: string;
}

/**
 * A Nest logger that keeps every line the application logs, as written: each
 * argument serialized in full — an error with its message and stack — before
 * any redaction. So "never logged" can be asserted of a value whatever key it
 * would have been logged under; the production logger's redaction by key is
 * a second line of defence, not the one tested here.
 *
 * Pass it to `startApi(env, { logger })`.
 */
export class LogCapture implements LoggerService {
  readonly lines: CapturedLine[] = [];

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.keep('log', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.keep('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.keep('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.keep('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.keep('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.keep('fatal', message, optionalParams);
  }

  /** Every line captured so far, one per line. */
  text(): string {
    return this.lines.map((line) => `${line.level} ${line.json}`).join('\n');
  }

  /** Each line's arguments, read back — the message first, Nest's context last. */
  logged(): unknown[][] {
    return this.lines.map((line) => JSON.parse(line.json) as unknown[]);
  }

  private keep(level: CapturedLine['level'], message: unknown, optionalParams: unknown[]): void {
    this.lines.push({ level, json: serialize([message, ...optionalParams]) });
  }
}

/**
 * JSON of anything, with nothing left out that could carry a value: an
 * error's name, message and stack are copied (JSON would drop them), and a
 * cycle is cut rather than thrown on.
 */
export function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return '[seen]';
    seen.add(item);
    return item instanceof Error
      ? { ...item, name: item.name, message: item.message, stack: item.stack }
      : item;
  });
  return json ?? String(value);
}

/** A signed token as identity and the media provider's SDK mint them: `eyJ…` header, payload, signature. */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** The fake provider's tokens (`fake.<room>.<identity>.<pub|sub>`), wherever they appear. */
const FAKE_TOKENS = new RegExp(FAKE_TOKEN_PATTERN.source, 'g');

/**
 * Every credential-shaped string in `text` — a JWT, or a token the fake
 * provider issued — whatever surrounds it. Empty when there is none.
 */
export function credentialsIn(text: string): string[] {
  return [...text.matchAll(JWT_SHAPE), ...text.matchAll(FAKE_TOKENS)].map((match) => match[0]);
}

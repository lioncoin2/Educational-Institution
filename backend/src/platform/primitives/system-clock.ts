import type { Clock } from '../../shared';

export { CLOCK } from '../../shared';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

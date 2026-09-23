/**
 * Time as a dependency.
 *
 * Domain code never calls `new Date()`; it asks the clock. That keeps every
 * time-dependent rule (session windows, token expiry, attendance cut-offs)
 * deterministic under test.
 */
export interface Clock {
  now(): Date;
}

/** A clock pinned to a fixed instant — for tests and deterministic replays. */
export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

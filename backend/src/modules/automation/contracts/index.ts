/**
 * Automation — "when X happens, do Y".
 *
 * Rules subscribe to domain events and invoke other modules' public use cases.
 * Keeping automation in its own module is what stops that logic from being
 * scattered through the modules that raise the events.
 */
export interface AutomationRule {
  readonly id: string;
  /** Domain event name this rule listens for, e.g. `live.session.ended`. */
  readonly on: string;
  readonly enabled: boolean;
  readonly description: string;
}

import type {
  DomainEvent,
  EventHandler,
  EventPublisher,
  EventSubscriber,
  Unsubscribe,
} from '../../shared';

export type { EventHandler, Unsubscribe };

/** DI token for the publisher port (defined in the shared kernel). */
export { EVENT_PUBLISHER } from '../../shared';

/**
 * In-process event bus.
 *
 * Deliberately not a message broker. Modules react to each other's facts without
 * importing each other, and that is the whole job at this stage. One rule makes
 * it safe: a failing subscriber never breaks the publisher, because the
 * publishing module's work is already committed by the time events go out.
 *
 * When a module is extracted into its own service, the transactional-outbox
 * table replaces this class and subscribers become consumers — the
 * `EventPublisher` port the modules depend on does not change.
 */
export class InProcessEventBus implements EventPublisher, EventSubscriber {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(
    /** Where subscriber failures go. Injected so the bus stays testable. */
    private readonly onHandlerError: (event: DomainEvent, error: unknown) => void = () => {},
  ) {}

  subscribe(eventName: string, handler: EventHandler): Unsubscribe {
    const set = this.handlers.get(eventName) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(eventName, set);
    return () => {
      set.delete(handler);
    };
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      const subscribers = this.handlers.get(event.name);
      if (subscribers === undefined) continue;
      // Snapshot: a handler may unsubscribe while we iterate.
      for (const handler of [...subscribers]) {
        try {
          await handler(event);
        } catch (error) {
          this.onHandlerError(event, error);
        }
      }
    }
  }
}

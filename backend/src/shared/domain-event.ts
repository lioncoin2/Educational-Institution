/**
 * Domain events.
 *
 * A fact that has already happened, named in the past tense. Events are the
 * sanctioned way for one module to react to another without importing it.
 * Deliberately simple: a name, when it happened, the aggregate it concerns and
 * a serializable payload. No broker, no schema registry, no choreography engine.
 */
export interface DomainEvent<TName extends string = string, TPayload = unknown> {
  readonly name: TName;
  readonly occurredAt: Date;
  /** Aggregate this event is about, for correlation and audit. */
  readonly aggregateId: string;
  readonly payload: TPayload;
  /** Correlates every event raised while handling one request. */
  readonly correlationId?: string;
}

export function domainEvent<TName extends string, TPayload>(
  name: TName,
  aggregateId: string,
  payload: TPayload,
  occurredAt: Date,
  correlationId?: string,
): DomainEvent<TName, TPayload> {
  return { name, aggregateId, payload, occurredAt, correlationId };
}

/** Anything that can publish events. Implemented in platform. */
export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

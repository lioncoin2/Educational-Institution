# 0006 — In-process domain events, outbox-ready

**Status:** Accepted
**Date:** 2026-09-23

## Context

Modules must react to each other's facts without importing each other.
`operations` records attendance when a live session ends; `notifications` tells
people; `reporting` counts it. None of that should be `live`'s concern.

The brief also set a ceiling:

> Events should not become a distributed-event-system overengineering exercise.
> Keep them simple and testable.

## Decision

An `EventPublisher` port in the shared kernel, and one ~30-line
`InProcessEventBus` implementing it. No broker, no schema registry, no
choreography engine.

```ts
interface DomainEvent<TName extends string = string, TPayload = unknown> {
  readonly name: TName;            // '<module>.<aggregate>.<pastTenseVerb>'
  readonly occurredAt: Date;
  readonly aggregateId: string;
  readonly payload: TPayload;
  readonly correlationId?: string;
}
```

Two properties carry the design:

**Subscriber errors are isolated.** By publish time the publisher's work is
committed. A failing subscriber must not roll it back, and must not prevent the
next subscriber from running. `onHandlerError` is *injected* rather than
hard-wired to a logger, which makes that property assertable in a unit test
rather than merely intended.

**Iteration over a snapshot.** A handler may unsubscribe mid-dispatch; without
the copy that is a mutation-during-iteration bug that appears only under a
specific ordering.

## Consequences

**Good.**
- `live` does not import `operations`, `notifications` or `reporting`, and does
  not change when they appear.
- Synchronous in-process dispatch means an event is trivial to test: publish,
  assert the subscriber ran.
- `correlationId` is present from the start, so "which request caused this
  chain" is answerable the first time it is asked rather than after a migration.
- The port is what modules depend on, so the outbox upgrade does not touch them.

**Bad, and accepted — stated plainly:**

| Property | Today |
| --- | --- |
| Ordering | per `publish()` call, array order |
| Delivery | in-process, synchronous, best-effort |
| Durability | **none** — a crash between commit and publish loses the event |
| Retry | none |
| Idempotency | subscriber's responsibility |

The durability gap is real. It is written down here rather than discovered in
production.

**Upgrade path,** which is why the port exists:
1. An `outbox` table; `publish()` writes rows in the business transaction.
2. A dispatcher reads the outbox and invokes subscribers, with retry.
3. `EventPublisher` — the interface every module depends on — does not change.

Modules never learn about the outbox. Likewise, when a module is extracted, the
bus becomes a broker and subscribers become consumers; again the port is
unchanged.

## Events are not audit

Easy to conflate, and must not be. An event is a fact offered to whoever cares;
subscribers come and go and losing one degrades a reaction. An audit entry
records who did what, must not be lost, and has no subscribers.

`ModerateSpeakerUseCase` writes audit *before* raising its event: the record of
the act matters more than the reaction to it.

## Alternatives considered

**A message broker now (RabbitMQ, Kafka, NATS).** Rejected as exactly the
overengineering the brief named. It adds a deployment, a failure mode and a
serialization contract to solve a problem — cross-process delivery — that does
not exist in a single process.

**Direct method calls between modules.** Rejected: creates the import graph
events exist to avoid, and in the wrong direction.

**Transactional outbox from day one.** The most tempting alternative, and close
to worth it. Rejected because it needs a database table, a dispatcher process
and a retry policy before any module raises a second event. The port makes it a
later, mechanical addition — so the cost of deferring is bounded and known.

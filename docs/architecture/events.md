# Events

The brief was specific about the failure mode to avoid:

> Events should not become a distributed-event-system overengineering exercise.
> Keep them simple and testable.

So: no broker, no schema registry, no choreography engine, no saga framework.
An interface, a class, and a rule about failure.

---

## 1. What an event is

A fact that has already happened, named in the past tense.

```ts
interface DomainEvent<TName extends string = string, TPayload = unknown> {
  readonly name: TName;            // 'live.speaker.granted'
  readonly occurredAt: Date;
  readonly aggregateId: string;    // what it is about
  readonly payload: TPayload;      // serializable
  readonly correlationId?: string; // ties together everything from one request
}
```

Five fields. `correlationId` is the only one that is not obvious, and it earns
its place: when an event chain misbehaves in production, the first question is
always *which request started this*, and the field has to be there from the
beginning to answer it.

Naming is `<module>.<aggregate>.<pastTenseVerb>`. The module prefix means a
subscriber can see where an event came from without a lookup, and it keeps two
modules from both defining `session.ended`.

Events are created through `domainEvent(...)`, which takes the clock's `now`
explicitly rather than calling `new Date()` internally — so event time is
controllable in tests, like every other time in the system.

---

## 2. What events are for

**The one job:** letting one module react to another's facts without importing
it.

`operations` needs to record attendance when a live session ends. The naive
version has `live` call into `operations`. That creates a permanent dependency,
in the wrong direction, from a module that should not know attendance exists.

Instead `live` raises `live.session.ended` and stops caring. `operations`
subscribes. `notifications` may also subscribe. `reporting` may subscribe.
`live` does not change when any of them appear — and `live` remains testable
without any of them present.

**Not the job:** replacing function calls. When `live` needs to know *right
now* whether a principal may moderate, it asks `identity` synchronously through
its contract. A question needing an answer is not an event.

The distinction in one line: **events are facts, contracts are questions.**

---

## 3. Delivery

`InProcessEventBus`, ~30 lines, implements the `EventPublisher` port:

```ts
async publish(events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) {
    const subscribers = this.handlers.get(event.name);
    if (subscribers === undefined) continue;
    for (const handler of [...subscribers]) {   // snapshot: a handler may unsubscribe mid-iteration
      try {
        await handler(event);
      } catch (error) {
        this.onHandlerError(event, error);      // a failing subscriber never breaks the publisher
      }
    }
  }
}
```

Two decisions are doing all the work here:

**Subscriber errors are isolated.** By the time events are published, the
publishing module's work is already done. If `notifications` throws, the
attendance record must not be rolled back, and the next subscriber must still
run. A bus that propagates subscriber failures back to the publisher silently
couples every module to the reliability of every other module that happens to
subscribe — the exact coupling events exist to prevent.

`onHandlerError` is injected rather than hard-wired to a logger, which is what
makes this property assertable in a unit test rather than merely intended.

**Iteration over a snapshot.** A handler may unsubscribe during dispatch.
Without the copy that is a mutation-during-iteration bug that appears only under
a specific ordering — the kind that surfaces in production and not in tests.

---

## 4. Guarantees, stated plainly

| Property | Today |
| --- | --- |
| Ordering | Per `publish()` call, in array order |
| Delivery | In-process, synchronous, best-effort |
| Durability | **None** — a crash between commit and publish loses the event |
| Retry | None |
| Idempotency | Subscriber's responsibility |

The durability gap is real and is accepted for this milestone. It is written
down here rather than discovered later.

The upgrade path is the standard one, and it is why the port exists:

1. Add an `outbox` table. `publish()` writes rows in the same transaction as the
   business change.
2. A dispatcher reads the outbox and invokes subscribers, with retry.
3. `EventPublisher` — the interface every module depends on — does not change.

Modules do not learn about the outbox. That is the point of the port.

Similarly, when a module is extracted into its own service, the bus is replaced
by a real broker and subscribers become consumers. Again the port is unchanged.

---

## 5. Events currently declared

| Event | Raised by | Likely subscribers |
| --- | --- | --- |
| `live.speaker.granted` | live | reporting, audit |
| `live.speaker.revoked` | live | reporting, audit |
| `live.session.started` | live | operations, notifications |
| `live.session.ended` | live | operations (attendance), reporting |
| `identity.user.created` | identity | people, notifications |
| `identity.role.assigned` | identity | notifications, reporting |
| `identity.role.revoked` | identity | reporting |
| `identity.account.status_changed` | identity | people, notifications |
| `operations.attendance.recorded` | operations | reporting, notifications |
| `messaging.message.sent` | messaging | notifications |

The `live.speaker.*` and `identity.*` events are raised by implemented code
today. The rest are declared so the vocabulary is settled before the modules
arrive. Identity's payloads carry ids and codes only. The Foundation's
`userCreated` carried the email address, which would have copied personal data
into every subscriber's storage.

---

## 6. Events and audit are different things

They are easy to conflate and must not be.

- **An event** is a fact offered to whoever cares. Subscribers may come and go.
  Losing one degrades a reaction.
- **An audit entry** is a record of *who did what*, written for accountability.
  It must not be lost, and nobody "subscribes" to it.

`ModerateSpeakerUseCase` does both, in this order: own state → provider → audit
→ event. Audit is written before the event is raised, because the record of the
act matters more than the reaction to it.

See [observability.md](observability.md) for the audit design.

---

## 7. Rules for adding an event

1. Past tense, `<module>.<aggregate>.<verb>`.
2. Payload carries **ids and values**, never entities. An entity in a payload
   re-couples the modules through its type.
3. The publisher must not care whether anyone subscribes.
4. A subscriber must tolerate receiving the same event twice — once retries
   exist, it will.
5. Never use an event to ask a question. Use a contract.

# 0002 — Modular monolith, not microservices

**Status:** Accepted
**Date:** 2026-09-23

## Context

The platform will eventually cover twelve-plus functional areas and an unknown
number of future modules. Two organizing options: one deployable with internal
boundaries, or a set of services.

The requirement is explicit that modules must be addable without rewriting
existing ones, and that boundaries must be strong enough to allow later
extraction.

## Decision

A modular monolith. One deployable process, hard internal boundaries,
mechanically enforced.

```
src/modules/<module>/
  domain/          entities, invariants, PORTS — zero dependencies
  application/     use cases
  infrastructure/  adapters
  api/             HTTP edge
  contracts/       the ONLY public surface
```

Cross-module communication: events by default, `contracts/` when an answer is
needed now, read models for reporting. Never another module's tables.

## Consequences

**Good.**
- One deployment, one log stream, one database, one transaction boundary. A use
  case that touches two modules is a function call, not a saga.
- Refactoring across a boundary is a compiler-checked change rather than a
  coordinated release of two services.
- Boundaries are enforced statically (ADR 0009), so they hold without the
  network being the thing that enforces them.
- Extraction stays possible: a module with its own domain, ports, contracts and
  schema is a service that happens to be linked in.

**Bad, and accepted.**
- The whole system scales as a unit. If `live` needs more instances than
  `reporting`, everything scales together — until a module is extracted.
- A memory leak or a crash in one module takes down all of them.
- Boundaries can be violated by anyone with a text editor. The network makes
  violation impossible; a lint rule only makes it loud. This is why the rules
  run in CI rather than in a document.

**The trade, stated plainly.** Microservices buy enforced isolation at the cost
of distributed-systems complexity for *every* interaction — network failure,
partial failure, eventual consistency, distributed tracing, versioned contracts
between deployables. That cost is worth paying when teams need independent
deployment or components need independent scaling. Neither is true here yet.

Paying it now would buy isolation we can also get from a static analysis rule,
at the price of a system that is harder to change during the period when it will
change most.

## Alternatives considered

**Microservices from the start.** Rejected as above. Premature for a team and a
product at this stage; the coordination cost lands before any of the benefits.

**Unstructured monolith.** Rejected: this is the option the brief explicitly
ruled out ("do not create spaghetti code"), and it is the one that makes the
twelfth module as expensive as the first.

**Monolith with packages but no enforcement.** Considered and rejected. It is
the same as this decision minus the only mechanism that makes it survive
contact with a deadline. Documented boundaries erode; checked ones do not.

## Revisiting

Extract a module when there is a *specific* reason: it needs to scale
independently, it needs a different runtime, or a separate team owns it. Not
because the codebase feels large.

The first candidate is `live`, because its load profile is genuinely different
from everything else. `RtcProvider`, the in-memory repositories and the event
publisher are all already ports, so extraction is a deployment change rather
than a redesign.

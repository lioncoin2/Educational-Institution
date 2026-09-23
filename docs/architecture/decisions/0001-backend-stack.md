# 0001 — TypeScript and NestJS for the backend

**Status:** Accepted
**Date:** 2026-09-23

## Context

The repository contained a Flutter prototype and no backend. A platform of this
scope needs one, and the choice constrains hiring, libraries and operations for
years.

Four candidates were considered seriously. This was the one genuine ambiguity in
the brief that could not be resolved from the repository or from sensible
defaults, so it was put to the project owner rather than guessed.

The owner chose TypeScript / NestJS.

## Decision

Node 22, TypeScript 5.7, NestJS 11. CommonJS output.

## Consequences

**Good.**
- One language across the API and any future web surface; one mental model for
  contributors.
- NestJS provides constructor DI out of the box, which is what makes
  ports-and-adapters practical rather than ceremonial. Every adapter in this
  codebase is swapped by changing one factory in a module file.
- `@nestjs/testing` plus Jest covers unit and integration testing without extra
  machinery.
- Large library ecosystem: `livekit-server-sdk`, `drizzle-orm`, `ioredis`,
  `pino` are all first-class.

**Bad, and accepted.**
- Node is single-threaded per process. CPU-bound work (report generation, media
  processing) must move to a worker or a job queue rather than being done
  in-request.
- TypeScript's types vanish at runtime, so boundary validation must be explicit.
  Hence `ValidationPipe` with `whitelist` and `forbidNonWhitelisted` on every
  inbound DTO.
- Nest's decorator-heavy style tempts people to put logic in controllers and
  guards. The dependency rules (ADR 0009) exist partly to counter that pull.

**Mitigation adopted.** `@nestjs/common` is the *only* framework import
permitted in the application layer, and only for DI decorators. The domain layer
may not import it at all. So the framework cannot spread inward past a line that
is mechanically checked.

## Alternatives considered

**Go.** Excellent concurrency story, genuinely attractive for the 2500-listener
signalling path, and a single static binary is pleasant to deploy. Rejected: a
second language in a small team, weaker DI conventions (which this architecture
leans on heavily), and a smaller pool of contributors who could work across both
the app and the backend.

**Python / FastAPI.** Fast to write, good typing story now. Rejected: weaker
compile-time guarantees than TypeScript at the module boundaries this design
depends on, and async-ecosystem inconsistency in libraries we would rely on.

**Kotlin / Spring Boot.** The strongest option on raw enforcement — the JVM's
module system and Spring's maturity would enforce boundaries even harder.
Rejected: heaviest operational footprint, slowest iteration for a team that is
not already a JVM team, and the largest distance from the existing Flutter work.

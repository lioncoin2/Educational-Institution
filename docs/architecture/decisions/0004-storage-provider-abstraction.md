# 0004 — Abstract binary storage behind a port

**Status:** Accepted
**Date:** 2026-09-23

## Context

The platform handles voice messages, images, documents, homework submissions and
certificate scans. The constraint was explicit: **do not store large binaries in
PostgreSQL.**

Deployment target is not yet known — it may be a single VM with a disk, or S3,
or an S3-compatible store.

## Decision

A `StorageProvider` port, presigned-URL-shaped, with `LocalStorageProvider`
implemented now and an S3-compatible adapter later.

```ts
export interface StorageProvider {
  createUploadUrl(request: UploadRequest): Promise<PresignedUpload>;
  createDownloadUrl(storageKey: string, expiresInSeconds: number): Promise<string>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<void>;
}
```

The database stores `FileAsset` metadata and a storage key. Never bytes.

## Consequences

**Good.**
- Database dumps, restores and replicas stay small. A 40 GB database of which
  38 GB is voice messages makes every routine operation slow for reasons
  unrelated to the data anyone queries.
- Object-store lifecycle rules (tiering, expiry) apply with no application
  change.
- The local adapter implements the *same signed-URL contract* as an object
  store — HMAC plus expiry, constant-time verification — so the S3 adapter is a
  drop-in rather than a change of model.
- Upload validation lives in the domain (`file-policy.ts`), so it is enforced
  wherever an upload is requested rather than at one endpoint.

**Bad, and accepted.**
- The presigned-URL shape is more complex than `save(bytes)` for the local
  filesystem case, where it is arguably ceremony. The complexity is paid now to
  avoid changing every caller later.
- Signed URLs are bearer capabilities: possession grants access, so expiry is
  the only thing limiting how far one travels. They are not currently bound to a
  principal — a one-line addition to the signed payload, listed as debt.
- Two adapters can drift. The local one is used in development, so drift shows
  up as a development-only bug, which is the better direction for it to fail.

## The decision inside the decision

`createUploadUrl` rather than `save(bytes)` is the choice that matters.

A `save(bytes)` interface forces every upload through the API process. A cohort
of 2500 students sending voice notes becomes 2500 large request bodies proxied
through the application — memory pressure, bandwidth cost, and request timeouts,
none of which the API adds any value to.

Presigned URLs let the client talk to the object store directly. The API issues
permission and nothing else. Writing the port this way now costs a little
ceremony in the local adapter; writing it the easy way would cost a change to
every caller the first time a real object store appears.

## Alternatives considered

**Binaries in PostgreSQL (bytea or large objects).** Simplest possible
transactional story — a file and its metadata commit together. Rejected: forbidden
by the brief, and for good reason; the database becomes the bottleneck for
something it is not good at.

**Use the AWS SDK directly.** Rejected: ties the codebase to one vendor and makes
local development require credentials or a MinIO container.

**Filesystem only, no abstraction.** Rejected: works until it does not. The
first horizontally-scaled deployment breaks it, and by then the assumption is in
every caller.

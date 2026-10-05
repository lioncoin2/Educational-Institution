import { IsString } from 'class-validator';

/**
 * The body of `POST /attendance/live-sessions/:liveSessionId/snapshots`: the
 * caller's idempotency key, and nothing else (attendance.md §15.1).
 *
 * A missing or non-string `clientRequestId` is a transport error — 400, from
 * the global pipe. A present-but-malformed one (the `^[A-Za-z0-9_-]{8,64}$`
 * shape) is the domain's to refuse — 422 `attendance.client_request_id_invalid`
 * (§15.2) — so the shape is deliberately NOT checked here; one source of truth
 * for the key's shape lives in the domain. Unknown fields are refused (400) by
 * the global `whitelist`/`forbidNonWhitelisted` pipe: the recorder, the
 * community, the host and whom to count are the server's to know, never a claim
 * in the request body.
 */
export class RecordSnapshotDto {
  @IsString()
  clientRequestId!: string;
}

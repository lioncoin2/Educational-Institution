import { randomUUID } from 'node:crypto';

import { AccessToken, type RoomServiceClient } from 'livekit-server-sdk';

import { isDeployed, type AppConfig } from '../../../platform/config/app-config';
import { apiUrlFault, clientUrlFault } from '../../../platform/config/livekit-config';
import type {
  RtcNotReadyReason,
  RtcReadinessProbe,
  RtcReadinessReport,
} from '../domain/rtc-provider';
import { LIVEKIT_REQUEST_TIMEOUT_SECONDS, classify } from './livekit-transport';

/** What the probe reads of the room service. */
export type LiveKitRoomLister = Pick<RoomServiceClient, 'listRooms'>;

/**
 * LiveKit's own answer for a room that does not exist
 * (SRV `pkg/service/errors.go:38`), written by `/rtc/validate` as the whole
 * plain-text body of a 404 (`HandleError`, `pkg/service/utils.go:84-87`).
 */
export const LIVEKIT_ROOM_NOT_FOUND_BODY = 'requested room does not exist';

/** What `/rtc/validate` writes when a join would be allowed (SRV `pkg/service/rtcservice.go:107-115`). */
export const LIVEKIT_VALIDATED_BODY = 'success';

/** The probe's own participant identity — never an account id, which is a uuid. */
export const READINESS_PROBE_IDENTITY = 'readiness-probe';

/** The probe token's lifetime: one request's worth. */
export const READINESS_PROBE_TTL_SECONDS = 30;

const READY: RtcReadinessReport = Object.freeze({ ready: true });

/**
 * The LiveKit adapter's self-check (live.md §9; P7.1): positively
 * identifies the configured server as a LiveKit that accepts this
 * deployment's credentials and runs with `room.auto_create` off. In order,
 * stopping at the first failure:
 *
 *   1. In a deployed environment, a client URL that is not wss:, or an API
 *      URL that would reach a public host over plain http:, is
 *      `insecure_url` — decided before any request, so no credential is ever
 *      sent in clear.
 *   2. The room API with the API credentials (`listRooms` of the probe's
 *      room): refused credentials → `unauthorized`; nothing answering →
 *      `unreachable`; a TLS or certificate failure → `tls_failure`; an answer
 *      that is not LiveKit's → `incompatible_response`.
 *   3. `GET {apiUrl}/rtc/validate`, with a Bearer token that may only join a
 *      random room of this deployment's form no live session can have
 *      (`<prefix>readiness-<uuid>`). The server runs its allocator check and
 *      creates nothing (SRV `pkg/service/rtcservice.go:107-125`,
 *      `pkg/service/utils.go:389-397`): LiveKit's own 404 means auto-create is
 *      off — ready; `200 success` means a valid join token would create the
 *      room — `auto_create_enabled`; 401 → `unauthorized`; anything else →
 *      `incompatible_response`.
 *
 * Never throws, and logs nothing: the application logs each transition. The
 * token travels only in the Authorization header — never in a URL — and
 * lives for READINESS_PROBE_TTL_SECONDS.
 */
export class LiveKitReadiness implements RtcReadinessProbe {
  constructor(
    private readonly config: AppConfig,
    private readonly rooms: LiveKitRoomLister,
    private readonly http: typeof fetch = fetch,
  ) {}

  async check(): Promise<RtcReadinessReport> {
    const { url, apiUrl } = this.config.livekit;
    if (
      isDeployed(this.config.nodeEnv) &&
      (clientUrlFault(url, true) !== null || apiUrlFault(apiUrl, true) !== null)
    ) {
      return notReady('insecure_url');
    }
    // Of this deployment's form, never a session's: a session room is the
    // prefix and a uuid, and `readiness-` is no uuid.
    const probeRoom = `${this.config.live.roomNamePrefix ?? ''}readiness-${randomUUID()}`;

    try {
      await this.rooms.listRooms([probeRoom]);
    } catch (error) {
      return notReady(reasonFor(error));
    }

    let status: number;
    let body: string;
    try {
      const response = await this.http(new URL('/rtc/validate', apiUrl), {
        method: 'GET',
        headers: { Authorization: `Bearer ${await this.probeToken(probeRoom)}` },
        // A redirect is not LiveKit's answer, and would carry the token elsewhere.
        redirect: 'manual',
        signal: AbortSignal.timeout(LIVEKIT_REQUEST_TIMEOUT_SECONDS * 1000),
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      return notReady(reasonFor(error));
    }
    if (status === 404 && body === LIVEKIT_ROOM_NOT_FOUND_BODY) return READY;
    if (status === 200 && body === LIVEKIT_VALIDATED_BODY) return notReady('auto_create_enabled');
    if (status === 401) return notReady('unauthorized');
    return notReady('incompatible_response');
  }

  /** A join-only token for the probe's room: it may publish, subscribe and send nothing. */
  private async probeToken(room: string): Promise<string> {
    const token = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: READINESS_PROBE_IDENTITY,
      ttl: READINESS_PROBE_TTL_SECONDS,
    });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: false,
      canPublishSources: [],
      canSubscribe: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }
}

/** A failed request, as a reason: only the failure's class decides, never its text. */
function reasonFor(error: unknown): RtcNotReadyReason {
  switch (classify(error)) {
    case 'misconfigured':
      return 'unauthorized';
    case 'unavailable':
      return 'unreachable';
    case 'tls':
      return 'tls_failure';
    default:
      return 'incompatible_response';
  }
}

function notReady(reason: RtcNotReadyReason): RtcReadinessReport {
  return { ready: false, reason };
}

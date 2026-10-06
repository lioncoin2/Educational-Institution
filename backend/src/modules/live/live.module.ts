import { Logger, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { DATABASE, type Database } from '../../platform/database';
import { CLOCK, type Clock } from '../../shared';
import { CommunitiesModule } from '../communities/communities.module';
import { IdentityModule } from '../identity/identity.module';
import { LiveController } from './api/live.controller';
import { LiveAudienceService } from './application/live-audience.service';
import { EndLiveSessionUseCase } from './application/end-live-session.use-case';
import { GetCurrentLiveSessionUseCase } from './application/get-current-live-session.use-case';
import { GetLiveSessionUseCase } from './application/get-live-session.use-case';
import { JoinLiveSessionUseCase } from './application/join-live-session.use-case';
import { KickParticipantUseCase } from './application/kick-participant.use-case';
import { ListHandsUseCase } from './application/list-hands.use-case';
import { LiveAccess } from './application/live-access';
import { LiveJournal } from './application/live-journal';
import { LiveMedia } from './application/live-media';
import { LiveMediaReadiness } from './application/live-media-readiness';
import { LiveMediaReset } from './application/live-media-reset';
import { LivePresenceService } from './application/live-presence.service';
import { LiveReconciler } from './application/live-reconciler';
import { LiveSessionLifecycle } from './application/live-session-lifecycle';
import { LiveSessionsReader } from './application/live-sessions.reader';
import {
  DEFAULT_ROOM_NAME_PREFIX,
  LIVE_SETTINGS,
  type LiveSettings,
} from './application/live-settings';
import { LiveStanding } from './application/live-standing';
import { LowerHandUseCase } from './application/lower-hand.use-case';
import { ModerateSpeakerUseCase } from './application/moderate-speaker.use-case';
import { PresenterUseCase } from './application/presenter.use-case';
import { ProtectLiveSessions } from './application/protect-live-sessions';
import { RaiseHandUseCase } from './application/raise-hand.use-case';
import { ResetRoomUseCase } from './application/reset-room.use-case';
import { RoomOccupancy } from './application/room-occupancy';
import { LiveSessionViews } from './application/session-views';
import { StartLiveSessionUseCase } from './application/start-live-session.use-case';
import { LIVE_AUDIENCE } from './contracts/live-audience';
import { LIVE_PRESENCE } from './contracts/presence';
import { LIVE_SESSIONS } from './contracts/live-sessions';
import {
  LIVE_SESSION_REPOSITORY,
  PRESENTER_GRANT_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type PresenterGrantRepository,
  type SpeakerRequestRepository,
} from './domain/ports';
import {
  RTC_OBSERVER,
  RTC_PARTICIPANTS,
  RTC_PROVIDER,
  RTC_READINESS,
  RTC_ROOMS,
  RTC_TOKENS,
  type RtcProvider,
} from './domain/rtc-provider';
import { DisabledRtcProvider } from './infrastructure/disabled-rtc-provider';
import { DrizzleLiveStore } from './infrastructure/drizzle-live-repositories';
import { FakeRtcProvider } from './infrastructure/fake-rtc-provider';
import { InMemoryLiveStore } from './infrastructure/in-memory-live-repositories';
import { LiveKitRtcProvider } from './infrastructure/livekit-rtc-provider';

/** The development default in app-config: no real media server behind it. */
const DEVELOPMENT_SECRET = 'development-only-secret';

/**
 * Which media provider this deployment binds (P6 audit, D19) — fail closed:
 *
 *   the development secret           the fake: development and tests, where
 *                                    no media flows and none is expected
 *   LIVE_MEDIA_PROVIDER=livekit      the LiveKit adapter — real media,
 *                                    enabled on purpose; configuration has
 *                                    already refused to boot without a room
 *                                    prefix, the pinned server version, a
 *                                    valid client URL (wss: when deployed),
 *                                    a real key and a strong secret of its own
 *   anything else                    the disabled provider: every call
 *                                    refuses, so Start answers 503
 *                                    live.media_unavailable with nothing
 *                                    stored — real credentials in the
 *                                    environment are never reached by accident
 *
 * Configuration merely existing never binds LiveKit, and binding it is not
 * yet trusting it: Start also waits for the adapter's `/rtc/validate`
 * self-check (`LiveMediaReadiness`). The choice is logged once at boot as
 * `live.provider.initialize` — the provider, the room prefix and, for
 * LiveKit, the API and client hosts and the server version; never a key or a
 * secret.
 */
export function rtcProviderFor(
  config: AppConfig,
  clock: Clock,
  logger: Pick<Logger, 'log' | 'warn'> = new Logger('LiveModule'),
): RtcProvider {
  const roomNamePrefix = liveSettingsFor(config).roomNamePrefix;
  const event = 'live.provider.initialize';
  if (config.livekit.apiSecret === DEVELOPMENT_SECRET) {
    logger.warn(
      { event, provider: 'fake', roomNamePrefix },
      'media provider: fake (development secret) — no live media will flow',
    );
    return new FakeRtcProvider(clock);
  }
  if (config.live.mediaProvider === 'livekit') {
    logger.log(
      {
        event,
        provider: 'livekit',
        apiHost: new URL(config.livekit.apiUrl).host,
        clientHost: new URL(config.livekit.url).host,
        roomNamePrefix,
        version: config.livekit.version,
      },
      'media provider: LiveKit',
    );
    return new LiveKitRtcProvider(config);
  }
  logger.warn(
    { event, provider: 'disabled', roomNamePrefix },
    'media provider: disabled — real media is not enabled (LIVE_MEDIA_PROVIDER), so no live session can start',
  );
  return new DisabledRtcProvider();
}

/**
 * The one store behind Live's three repository ports: a session, its hands
 * and its presenter grant are read as written, and in Postgres every
 * transition of a session queues behind one admission mutex, whichever port
 * it comes through (live.md §10.2).
 */
export const LIVE_STORE = Symbol('LIVE_STORE');

export interface LiveStore {
  readonly sessions: LiveSessionRepository;
  readonly requests: SpeakerRequestRepository;
  readonly presenters: PresenterGrantRepository;
}

/** Postgres when a database is configured; otherwise the in-memory twin (mock mode). */
export function liveStoreFor(
  config: AppConfig,
  db: Database,
  memory: InMemoryLiveStore,
): LiveStore {
  return config.database.configured ? new DrizzleLiveStore(db) : memory;
}

/** What the use cases read of the configuration (plan §2.5). */
export function liveSettingsFor(config: AppConfig): LiveSettings {
  return Object.freeze({
    roomNamePrefix: config.live.roomNamePrefix ?? DEFAULT_ROOM_NAME_PREFIX,
    participantCap: config.live.maxParticipantsPerSession,
    moderatorReserve: config.live.moderatorReserve,
    joinTokenTtlSeconds: config.live.joinTokenTtlSeconds,
  });
}

/**
 * Live — community-scoped live sessions: starting and ending them, joining
 * with a short-lived media ticket, the raise-hand queue, the speaker floor
 * and the presenter slot (docs/architecture/live.md, P6).
 *
 * Who may do what is Communities' answer (COMMUNITY_AUTHORIZATION, through
 * `LiveAccess`) within identity's ceilings; Live stores no membership and
 * copies no rule. The media provider is bound once, here, and everything
 * above depends on the narrow RTC ports, each bound to that one provider.
 *
 * Sessions, hands, presenter grants and the moderation record are Live's own
 * tables (live.md §10), through the Drizzle adapters when a database is
 * configured; without one, the in-memory twins keep every guarantee (mock
 * mode). `LiveReconciler` keeps the media provider in line with that record
 * — rooms, eligibility and capabilities — on its own timers, never on a
 * guess (live.md §11); `ProtectLiveSessions` has it look at once when
 * Communities announces a removal, a revocation, a transfer or a lock
 * (§11.6), and the sweep backstops any event that is lost.
 *
 * It exports its contracts only (§13):
 *
 *   LIVE_SESSIONS   a session's scope, from Live's own record
 *   LIVE_AUDIENCE   who a session's facts may reach, as Communities answers it
 *   LIVE_PRESENCE   one observation of who the provider holds now (P9), over
 *                   RTC_OBSERVER; importable by attendance only
 */
@Module({
  imports: [IdentityModule, CommunitiesModule],
  controllers: [LiveController],
  providers: [
    {
      provide: RTC_PROVIDER,
      inject: [APP_CONFIG, CLOCK],
      useFactory: (config: AppConfig, clock: Clock): RtcProvider => rtcProviderFor(config, clock),
    },
    { provide: RTC_ROOMS, useExisting: RTC_PROVIDER },
    { provide: RTC_TOKENS, useExisting: RTC_PROVIDER },
    { provide: RTC_PARTICIPANTS, useExisting: RTC_PROVIDER },
    { provide: RTC_OBSERVER, useExisting: RTC_PROVIDER },
    { provide: RTC_READINESS, useExisting: RTC_PROVIDER },
    { provide: LIVE_SETTINGS, inject: [APP_CONFIG], useFactory: liveSettingsFor },
    // One store serves the three ports in either mode, so a session and its
    // hands and presenter grant are read as written.
    InMemoryLiveStore,
    {
      provide: LIVE_STORE,
      inject: [APP_CONFIG, DATABASE, InMemoryLiveStore],
      useFactory: liveStoreFor,
    },
    {
      provide: LIVE_SESSION_REPOSITORY,
      inject: [LIVE_STORE],
      useFactory: (store: LiveStore) => store.sessions,
    },
    {
      provide: SPEAKER_REQUEST_REPOSITORY,
      inject: [LIVE_STORE],
      useFactory: (store: LiveStore) => store.requests,
    },
    {
      provide: PRESENTER_GRANT_REPOSITORY,
      inject: [LIVE_STORE],
      useFactory: (store: LiveStore) => store.presenters,
    },
    LiveJournal,
    LiveAccess,
    LiveStanding,
    LiveMedia,
    // The provider's self-check, cached: asked at boot, at every room sweep
    // and by Start (P7.1).
    LiveMediaReadiness,
    RoomOccupancy,
    // The epoch bump + room swap the reconciler and the moderator reset share (Q64, ADR 0026).
    LiveMediaReset,
    LiveSessionViews,
    LiveSessionLifecycle,
    StartLiveSessionUseCase,
    EndLiveSessionUseCase,
    GetLiveSessionUseCase,
    GetCurrentLiveSessionUseCase,
    JoinLiveSessionUseCase,
    RaiseHandUseCase,
    LowerHandUseCase,
    ModerateSpeakerUseCase,
    ListHandsUseCase,
    PresenterUseCase,
    // Q64: a moderator removes a participant (an administrative disconnect) or
    // resets the media room (the shared epoch bump, commanded).
    KickParticipantUseCase,
    ResetRoomUseCase,
    // Brings the media provider in line with the record (live.md §11): a boot
    // pass, then three unref'd timers on the periods of live-limits.ts.
    LiveReconciler,
    ProtectLiveSessions,
    { provide: LIVE_SESSIONS, useClass: LiveSessionsReader },
    { provide: LIVE_AUDIENCE, useClass: LiveAudienceService },
    { provide: LIVE_PRESENCE, useClass: LivePresenceService },
  ],
  exports: [LIVE_AUDIENCE, LIVE_SESSIONS, LIVE_PRESENCE],
})
export class LiveModule {}

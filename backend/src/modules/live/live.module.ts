import { Logger, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { IdentityModule } from '../identity/identity.module';
import { LiveController } from './api/live.controller';
import { CapabilityConvergence } from './application/capability-convergence';
import { JoinLiveSessionUseCase } from './application/join-live-session.use-case';
import { LiveJournal } from './application/live-journal';
import { LiveStanding } from './application/live-standing';
import { LowerHandUseCase } from './application/lower-hand.use-case';
import { ModerateSpeakerUseCase } from './application/moderate-speaker.use-case';
import { RaiseHandUseCase } from './application/raise-hand.use-case';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
} from './domain/ports';
import {
  RTC_OBSERVER,
  RTC_PARTICIPANTS,
  RTC_PROVIDER,
  RTC_ROOMS,
  RTC_TOKENS,
  type RtcProvider,
} from './domain/rtc-provider';
import { FakeRtcProvider } from './infrastructure/fake-rtc-provider';
import {
  InMemoryLiveRoomRepository,
  InMemoryLiveSessionRepository,
  InMemorySpeakerRequestRepository,
} from './infrastructure/in-memory-live-repositories';
import { LiveKitRtcProvider } from './infrastructure/livekit-rtc-provider';

/** The development default in app-config: no real media server behind it. */
const DEVELOPMENT_SECRET = 'development-only-secret';

/**
 * Live — realtime audio sessions, the raise-hand queue and moderation of who
 * may speak.
 *
 * The provider is chosen once, here, and said so in the log. Everything above
 * depends on the narrow RTC ports, each bound to that one provider, so
 * development and tests run against the fake while production talks to
 * LiveKit — with no difference in the code under test.
 *
 * Sessions and hands are in memory until community-scoped sessions land with
 * their Postgres tables (docs/architecture/live.md, P6).
 */
@Module({
  imports: [IdentityModule],
  controllers: [LiveController],
  providers: [
    {
      provide: RTC_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RtcProvider => {
        const logger = new Logger('LiveModule');
        if (config.livekit.apiSecret === DEVELOPMENT_SECRET) {
          // Without real credentials there is nothing to talk to; failing
          // closed onto the fake keeps development working and makes it
          // obvious that no media provider is attached.
          logger.warn('media provider: fake (development secret) — no live media will flow');
          return new FakeRtcProvider();
        }
        logger.log({ host: new URL(config.livekit.url).host }, 'media provider: LiveKit');
        return new LiveKitRtcProvider(config);
      },
    },
    { provide: RTC_ROOMS, useExisting: RTC_PROVIDER },
    { provide: RTC_TOKENS, useExisting: RTC_PROVIDER },
    { provide: RTC_PARTICIPANTS, useExisting: RTC_PROVIDER },
    { provide: RTC_OBSERVER, useExisting: RTC_PROVIDER },
    { provide: LIVE_ROOM_REPOSITORY, useFactory: () => new InMemoryLiveRoomRepository() },
    { provide: LIVE_SESSION_REPOSITORY, useFactory: () => new InMemoryLiveSessionRepository() },
    {
      provide: SPEAKER_REQUEST_REPOSITORY,
      useFactory: () => new InMemorySpeakerRequestRepository(),
    },
    LiveJournal,
    LiveStanding,
    CapabilityConvergence,
    JoinLiveSessionUseCase,
    RaiseHandUseCase,
    LowerHandUseCase,
    ModerateSpeakerUseCase,
  ],
})
export class LiveModule {}

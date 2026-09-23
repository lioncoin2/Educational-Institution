import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../platform/config/app-config';
import { IdentityModule } from '../identity/identity.module';
import { LiveController } from './api/live.controller';
import { JoinLiveSessionUseCase } from './application/join-live-session.use-case';
import { ModerateSpeakerUseCase } from './application/moderate-speaker.use-case';
import { RequestSpeakerUseCase } from './application/request-speaker.use-case';
import {
  LIVE_ROOM_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  MODERATION_LOG,
  SPEAKER_REQUEST_REPOSITORY,
} from './domain/ports';
import { RTC_PROVIDER } from './domain/rtc-provider';
import { FakeRtcProvider } from './infrastructure/fake-rtc-provider';
import {
  InMemoryLiveRoomRepository,
  InMemoryLiveSessionRepository,
  InMemoryModerationLog,
  InMemorySpeakerRequestRepository,
} from './infrastructure/in-memory-live-repositories';
import { LiveKitRtcProvider } from './infrastructure/livekit-rtc-provider';

/**
 * Live — realtime audio rooms, the raise-hand queue and host moderation.
 *
 * The provider is chosen once, here. Everything above depends on the
 * `RTC_PROVIDER` port, so development and tests run against the fake while
 * production talks to LiveKit — with no difference in the code under test.
 *
 * Persistence is in-memory for this milestone; the Postgres and Redis adapters
 * implement the same ports (see docs/architecture/realtime.md for the intended
 * Redis-queue / Postgres-record split).
 */
@Module({
  imports: [IdentityModule],
  controllers: [LiveController],
  providers: [
    {
      provide: RTC_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        // Without real credentials there is nothing to talk to; failing closed
        // onto the fake keeps local development working and makes it obvious in
        // logs that no media provider is attached.
        config.livekit.apiSecret === 'development-only-secret'
          ? new FakeRtcProvider()
          : new LiveKitRtcProvider(config),
    },
    { provide: LIVE_ROOM_REPOSITORY, useFactory: () => new InMemoryLiveRoomRepository() },
    { provide: LIVE_SESSION_REPOSITORY, useFactory: () => new InMemoryLiveSessionRepository() },
    {
      provide: SPEAKER_REQUEST_REPOSITORY,
      useFactory: () => new InMemorySpeakerRequestRepository(),
    },
    { provide: MODERATION_LOG, useFactory: () => new InMemoryModerationLog() },
    JoinLiveSessionUseCase,
    RequestSpeakerUseCase,
    ModerateSpeakerUseCase,
  ],
})
export class LiveModule {}

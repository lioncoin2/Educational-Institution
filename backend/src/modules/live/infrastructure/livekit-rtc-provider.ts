import { Inject, Injectable, Logger } from '@nestjs/common';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import type {
  RtcAccessGrant,
  RtcAccessToken,
  RtcCapabilities,
  RtcProvider,
  RtcRoomSpec,
} from '../domain/rtc-provider';

/**
 * The LiveKit adapter — the only file in the system that imports LiveKit.
 *
 * Everything above it speaks the `RtcProvider` port, so swapping providers, or
 * running the whole live feature against a fake in tests, is a one-line change
 * in `live.module.ts`.
 *
 * The API secret never leaves the server: clients receive only a short-lived,
 * capability-scoped join token minted here.
 */
@Injectable()
export class LiveKitRtcProvider implements RtcProvider {
  private readonly logger = new Logger(LiveKitRtcProvider.name);
  private readonly rooms: RoomServiceClient;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    // The client API speaks ws(s); the server API speaks http(s) to the same host.
    const httpUrl = config.livekit.url.replace(/^ws/, 'http');
    this.rooms = new RoomServiceClient(httpUrl, config.livekit.apiKey, config.livekit.apiSecret);
  }

  async ensureRoom(spec: RtcRoomSpec): Promise<void> {
    try {
      await this.rooms.createRoom({
        name: spec.roomName,
        emptyTimeout: spec.emptyTimeoutSeconds,
        maxParticipants: spec.maxParticipants,
      });
    } catch (error) {
      // createRoom is idempotent in practice; an existing room is not a failure.
      this.logger.debug({ room: spec.roomName, err: error }, 'createRoom returned an error');
    }
  }

  async issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken> {
    const token = new AccessToken(this.config.livekit.apiKey, this.config.livekit.apiSecret, {
      identity: grant.identity,
      name: grant.displayName,
      ttl: grant.ttlSeconds,
    });

    token.addGrant({
      roomJoin: true,
      room: grant.roomName,
      canPublish: grant.capabilities.canPublishAudio,
      canSubscribe: grant.capabilities.canSubscribe,
      canPublishData: grant.capabilities.canPublishData,
      // Even when publishing is allowed, only a microphone is ever permitted.
      canPublishSources: grant.capabilities.canPublishAudio ? [TrackSource.MICROPHONE] : [],
    });

    return {
      token: await token.toJwt(),
      url: this.config.livekit.url,
      expiresInSeconds: grant.ttlSeconds,
    };
  }

  async updateCapabilities(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
  ): Promise<void> {
    await this.rooms.updateParticipant(roomName, identity, {
      permission: {
        canPublish: capabilities.canPublishAudio,
        canSubscribe: capabilities.canSubscribe,
        canPublishData: capabilities.canPublishData,
        canPublishSources: capabilities.canPublishAudio ? [TrackSource.MICROPHONE] : [],
      },
    });
  }

  async muteParticipant(roomName: string, identity: string): Promise<void> {
    const participant = await this.rooms.getParticipant(roomName, identity);
    const audioTracks = (participant.tracks ?? []).filter(
      (track) => track.source === TrackSource.MICROPHONE,
    );
    await Promise.all(
      audioTracks.map((track) =>
        this.rooms.mutePublishedTrack(roomName, identity, track.sid, true),
      ),
    );
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    await this.rooms.removeParticipant(roomName, identity);
  }

  async endRoom(roomName: string): Promise<void> {
    await this.rooms.deleteRoom(roomName);
  }
}
